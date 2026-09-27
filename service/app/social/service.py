"""Publish, vote, delete, and feed orchestration with short write transactions."""

from __future__ import annotations

import hashlib
import json
import secrets
from pathlib import Path
from typing import Optional

from ..db import Database, iso, now_ms
from ..errors import ServiceError, app_error
from ..http_utils import cursor_int, decode_cursor, encode_cursor
from . import media, repository as repo
from .schemas import normalize_caption

PUBLISH_OPERATION = "social.publish"
HEAD_COUNT_CAP = 99


# ---- Representation ----------------------------------------------------------

def post_payload(post, vote_row, viewer_player_id: Optional[str], api_base: str) -> dict:
    return {
        "id": post["id"],
        "feedSeq": post["feed_seq"],
        "createdAt": iso(post["created_at"]),
        "authorLabel": post["author_label"],
        "caption": post["caption"],
        "result": {
            "score": post["scan_score"],
            "tier": post["tier"],
            "modelVersion": post["model_version"],
            "displayMapVersion": post["display_map_version"],
            "captureMode": post["capture_mode"],
            "achievedAt": iso(post["result_created_at"]),
        },
        "mediaUrl": f"{api_base}/posts/{post['id']}/media" if post["media_id"] else None,
        "mogScore": post["mog_score"],
        "upCount": post["up_count"],
        "downCount": post["down_count"],
        "postRevision": post["revision"],
        "viewerVote": int(vote_row["value"]) if vote_row is not None else 0,
        "viewerVoteRevision": int(vote_row["revision"]) if vote_row is not None else 0,
        "isOwner": viewer_player_id is not None and post["owner_player_id"] == viewer_player_id,
    }


def vote_state(post, vote_row) -> dict:
    return {
        "postId": post["id"],
        "mogScore": post["mog_score"],
        "upCount": post["up_count"],
        "downCount": post["down_count"],
        "postRevision": post["revision"],
        "viewerVote": int(vote_row["value"]) if vote_row is not None else 0,
        "viewerVoteRevision": int(vote_row["revision"]) if vote_row is not None else 0,
    }


def _payloads(conn, posts, viewer_player_id: Optional[str], api_base: str) -> list[dict]:
    votes = repo.viewer_votes(conn, viewer_player_id, [p["id"] for p in posts]) if viewer_player_id else {}
    return [post_payload(p, votes.get(p["id"]), viewer_player_id, api_base) for p in posts]


def _require_active(post) -> None:
    if post is None:
        raise app_error(404, "post_not_found", "That mog does not exist.")
    if post["deleted_at"] is not None:
        raise app_error(410, "post_deleted", "That mog was deleted.")


# ---- Publishing --------------------------------------------------------------

def _fingerprint(result_id: str, caption: Optional[str], include_photo: bool) -> str:
    canonical = json.dumps({"r": result_id, "c": caption, "p": include_photo}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _check_eligibility(conn, player_id: str, result_id: str) -> tuple:
    result = repo.get_result(conn, result_id)
    if result is None:
        raise app_error(404, "result_not_found", "That result does not exist.")
    if result["player_id"] != player_id:
        raise app_error(403, "result_not_owned", "You can only share your own results.")
    publication = repo.get_publication(conn, result_id)
    if publication is None:
        raise app_error(409, "result_not_published", "Save this result to the shared leaderboard before posting it.")
    if result["match_id"] is not None:
        # The shared 1v1 reveal is not implemented; a match result stays sealed.
        raise app_error(409, "match_not_revealed", "Match results can be shared after the reveal finishes.")
    existing = repo.get_post_by_result(conn, result_id)
    if existing is not None:
        if existing["deleted_at"] is not None:
            raise app_error(410, "result_post_deleted", "You deleted the mog for this result, so it can't be posted again.")
        raise app_error(409, "result_already_posted", "This result is already posted.", {"postId": existing["id"]})
    return result, publication


def _replay(conn, dedup, fingerprint: str, player_id: str, api_base: str) -> Optional[dict]:
    if dedup is None:
        return None
    if dedup["fingerprint"] != fingerprint:
        raise app_error(409, "idempotency_conflict", "That retry key was already used for a different post.")
    post = repo.get_post(conn, dedup["resource_id"])
    _require_active(post)
    vote = repo.get_vote(conn, post["id"], player_id)
    return post_payload(post, vote, player_id, api_base)


def publish(
    db: Database,
    media_dir: Path,
    *,
    player_id: str,
    idempotency_key: str,
    result_id: str,
    raw_caption: Optional[str],
    include_photo: bool,
    api_base: str,
    retention_ms: int,
) -> tuple[dict, bool]:
    """Create one post and its author Up Mog atomically. Returns (post, created)."""
    caption = normalize_caption(raw_caption)
    fingerprint = _fingerprint(result_id, caption, include_photo)
    now = now_ms()

    # Cheap pre-checks outside the write lock; everything is rechecked inside.
    with db.read() as conn:
        replay = _replay(conn, repo.get_dedup(conn, player_id, PUBLISH_OPERATION, idempotency_key, now), fingerprint, player_id, api_base)
        if replay is not None:
            return replay, False
        _check_eligibility(conn, player_id, result_id)
        source = media.find_owned_source_photo(conn, player_id, result_id) if include_photo else None
    if include_photo and source is None:
        raise app_error(410, "source_media_expired", "The scan photo for this result isn't available. Post without it?")

    staged_media_id = media.stage_copy(db, media_dir, player_id, source) if source is not None else None
    post_id = secrets.token_urlsafe(9)
    try:
        with db.write() as conn:
            replay = _replay(conn, repo.get_dedup(conn, player_id, PUBLISH_OPERATION, idempotency_key, now), fingerprint, player_id, api_base)
            if replay is not None:
                created = False
                payload = replay
            else:
                result, publication = _check_eligibility(conn, player_id, result_id)
                author = (publication["display_name_snapshot"] or "").strip() or "Anonymous"
                repo.insert_post(
                    conn, post_id=post_id, owner_player_id=player_id, result=result, author_label=author,
                    caption=caption, media_id=staged_media_id, now=now,
                )
                repo.insert_vote(conn, post_id, player_id, 1, 1, now)
                if staged_media_id is not None:
                    media.attach(conn, staged_media_id, post_id)
                repo.put_dedup(conn, player_id, PUBLISH_OPERATION, idempotency_key, fingerprint, post_id, now, retention_ms)
                post = repo.get_post(conn, post_id)
                payload = post_payload(post, repo.get_vote(conn, post_id, player_id), player_id, api_base)
                created = True
    except BaseException:
        if staged_media_id is not None:
            media.mark_staged_for_cleanup(db, staged_media_id)
        raise
    if not created and staged_media_id is not None:
        media.mark_staged_for_cleanup(db, staged_media_id)
    return payload, created


# ---- Voting ------------------------------------------------------------------

def set_vote(db: Database, *, post_id: str, player_id: str, value: int, expected_revision: int) -> dict:
    """Set the caller's desired vote state. Never a toggle; stable on retry."""
    now = now_ms()
    with db.write() as conn:
        post = repo.get_post(conn, post_id)
        _require_active(post)
        current = repo.get_vote(conn, post_id, player_id)
        old_value = int(current["value"]) if current is not None else 0
        old_revision = int(current["revision"]) if current is not None else 0
        if old_value == value:
            return vote_state(post, current)
        if expected_revision != old_revision:
            raise ServiceError(
                409, "vote_conflict", "Your vote changed somewhere else. Here's the latest.", vote_state(post, current)
            )
        up_delta = int(value == 1) - int(old_value == 1)
        down_delta = int(value == -1) - int(old_value == -1)
        repo.upsert_vote(conn, post_id, player_id, value, now)
        repo.apply_count_deltas(conn, post_id, up_delta, down_delta)
        post = repo.get_post(conn, post_id)
        return vote_state(post, repo.get_vote(conn, post_id, player_id))


# ---- Deletion ----------------------------------------------------------------

def delete_post(db: Database, *, post_id: str, player_id: str) -> None:
    with db.read() as conn:
        post = repo.get_post(conn, post_id)
    if post is None:
        raise app_error(404, "post_not_found", "That mog does not exist.")
    if post["owner_player_id"] != player_id:
        raise app_error(403, "post_not_owned", "You can only delete your own mogs.")
    if post["deleted_at"] is not None:
        return  # Idempotent owner retry.
    now = now_ms()
    with db.write() as conn:
        post = repo.get_post(conn, post_id)
        if post["owner_player_id"] != player_id:
            raise app_error(403, "post_not_owned", "You can only delete your own mogs.")
        if post["deleted_at"] is not None:
            return
        media.schedule_delete(conn, post_id, now)
        repo.tombstone(conn, post_id, now)


# ---- Reads -------------------------------------------------------------------

def get_one(db: Database, post_id: str, viewer_player_id: Optional[str], api_base: str) -> dict:
    with db.read() as conn:
        post = repo.get_post(conn, post_id)
        _require_active(post)
        return _payloads(conn, [post], viewer_player_id, api_base)[0]


def _feed_cursor(cursor: Optional[str], feed: str) -> Optional[dict]:
    if not cursor:
        return None
    data = decode_cursor(cursor)
    if data.get("v") != 1 or data.get("f") != feed:
        raise app_error(400, "invalid_cursor", "That page cursor is not valid.")
    return data


def seq_feed(
    db: Database,
    *,
    feed: str,
    cursor: Optional[str],
    limit: int,
    viewer_player_id: Optional[str],
    owner_player_id: Optional[str],
    api_base: str,
) -> dict:
    """Snapshot keyset pagination by feed_seq (Latest and My Mogs)."""
    data = _feed_cursor(cursor, feed)
    with db.read() as conn:
        if data is None:
            snapshot = repo.max_active_seq(conn, owner_player_id)
            before = None
        else:
            snapshot = cursor_int(data, "s")
            before = cursor_int(data, "b", 1)
        rows = repo.feed_page(conn, snapshot, before, limit + 1, owner_player_id)
        more = len(rows) > limit
        rows = rows[:limit]
        items = _payloads(conn, rows, viewer_player_id, api_base)
    next_cursor = (
        encode_cursor({"v": 1, "f": feed, "s": snapshot, "b": rows[-1]["feed_seq"]}) if more and rows else None
    )
    return {"items": items, "nextCursor": next_cursor, "snapshotMaxSeq": snapshot}


def upmog_feed(db: Database, *, cursor: Optional[str], limit: int, player_id: str, api_base: str) -> dict:
    data = _feed_cursor(cursor, "upmogs")
    before = None
    if data is not None:
        post_id = data.get("p")
        if not isinstance(post_id, str) or len(post_id) > 32:
            raise app_error(400, "invalid_cursor", "That page cursor is not valid.")
        before = (cursor_int(data, "u"), post_id)
    with db.read() as conn:
        rows = repo.upmog_page(conn, player_id, before, limit + 1)
        more = len(rows) > limit
        rows = rows[:limit]
        items = _payloads(conn, rows, player_id, api_base)
    next_cursor = (
        encode_cursor({"v": 1, "f": "upmogs", "u": rows[-1]["vote_updated_at"], "p": rows[-1]["id"]})
        if more and rows else None
    )
    return {"items": items, "nextCursor": next_cursor, "snapshotMaxSeq": None}


def head(db: Database, after_seq: int) -> dict:
    with db.read() as conn:
        newer = repo.count_newer(conn, after_seq, HEAD_COUNT_CAP)
        head_seq = repo.max_active_seq(conn)
    return {"newCount": min(newer, HEAD_COUNT_CAP), "capped": newer > HEAD_COUNT_CAP, "headSeq": head_seq}


def states(db: Database, ids: list[str], viewer_player_id: Optional[str]) -> list[dict]:
    unique = list(dict.fromkeys(ids))
    with db.read() as conn:
        posts = repo.posts_by_ids(conn, unique)
        votes = repo.viewer_votes(conn, viewer_player_id, list(posts)) if viewer_player_id else {}
    out = []
    for post_id in unique:
        post = posts.get(post_id)
        if post is None:
            out.append({"postId": post_id, "status": "missing"})
        elif post["deleted_at"] is not None:
            out.append({"postId": post_id, "status": "deleted"})
        else:
            out.append({"status": "active", **vote_state(post, votes.get(post_id))})
    return out


def shareable_results(db: Database, *, cursor: Optional[str], limit: int, player_id: str) -> dict:
    data = _feed_cursor(cursor, "shareable")
    before = None
    if data is not None:
        result_id = data.get("r")
        if not isinstance(result_id, str) or len(result_id) > 64:
            raise app_error(400, "invalid_cursor", "That page cursor is not valid.")
        before = (cursor_int(data, "t"), result_id)
    with db.read() as conn:
        rows = repo.shareable_results_page(conn, player_id, before, limit + 1)
        more = len(rows) > limit
        rows = rows[:limit]
        items = []
        for row in rows:
            post_status = None
            if row["post_id"] is not None:
                post_status = "deleted" if row["post_deleted_at"] is not None else "active"
            items.append(
                {
                    "resultId": row["result_id"],
                    "displayName": row["display_name_snapshot"] or "Anonymous",
                    "score": row["score"],
                    "tier": row["tier"],
                    "modelVersion": row["model_version"],
                    "displayMapVersion": row["display_map_version"],
                    "captureMode": row["capture_mode"],
                    "achievedAt": iso(row["result_created_at"]),
                    "publishedAt": iso(row["first_published_at"]),
                    "postId": row["post_id"],
                    "postStatus": post_status,
                    "photoAvailable": media.find_owned_source_photo(conn, player_id, row["result_id"]) is not None,
                    "revealComplete": row["match_id"] is None,
                }
            )
    next_cursor = (
        encode_cursor({"v": 1, "f": "shareable", "t": rows[-1]["first_published_at"], "r": rows[-1]["result_id"]})
        if more and rows else None
    )
    return {"items": items, "nextCursor": next_cursor}
