"""Comments on mogs, each with its own Up Mog / Down Mog counter.

Comment voting uses exactly the same rules as post voting: desired state
(-1, 0, +1), per-player revisions, stale writes rejected, and a new comment
starts at 1 from its author's automatic Up Mog. Comment votes never change the
post's mog count, and post votes never change a comment's count.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import unicodedata
from typing import Optional

from ..db import Database, iso, now_ms
from ..errors import ServiceError, app_error
from ..http_utils import cursor_int, decode_cursor, encode_cursor
from . import repository as post_repo

COMMENT_MAX_CODE_POINTS = 500
CREATE_OPERATION = "social.comment"


# ---- Validation ----------------------------------------------------------------

def normalize_body(raw: str) -> str:
    """Trim, normalize line endings, reject control characters; plain text only."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise app_error(400, "invalid_comment", "Write something first.")
    for ch in text:
        if ch != "\n" and unicodedata.category(ch) in ("Cc", "Cs"):
            raise app_error(400, "invalid_comment", "Comments can't contain control characters.")
    if len(text) > COMMENT_MAX_CODE_POINTS:
        raise app_error(400, "invalid_comment", f"Comments are limited to {COMMENT_MAX_CODE_POINTS} characters.")
    return text


# ---- Queries ---------------------------------------------------------------------

def _get(conn, comment_id: str):
    return conn.execute("SELECT * FROM social_comments WHERE id = ?", (comment_id,)).fetchone()


def _get_vote(conn, comment_id: str, player_id: str):
    return conn.execute(
        "SELECT value, revision FROM social_comment_votes WHERE comment_id = ? AND player_id = ?", (comment_id, player_id)
    ).fetchone()


def _viewer_votes(conn, player_id: Optional[str], comment_ids: list[str]) -> dict:
    if not player_id or not comment_ids:
        return {}
    marks = ",".join("?" for _ in comment_ids)
    rows = conn.execute(
        f"SELECT comment_id, value, revision FROM social_comment_votes WHERE player_id = ? AND comment_id IN ({marks})",
        (player_id, *comment_ids),
    ).fetchall()
    return {row["comment_id"]: row for row in rows}


def _require_active_post(conn, post_id: str):
    post = post_repo.get_post(conn, post_id)
    if post is None:
        raise app_error(404, "post_not_found", "That mog does not exist.")
    if post["deleted_at"] is not None:
        raise app_error(410, "post_deleted", "That mog was deleted.")
    return post


def _require_active_comment(conn, comment_id: str):
    comment = _get(conn, comment_id)
    if comment is None:
        raise app_error(404, "comment_not_found", "That comment does not exist.")
    if comment["deleted_at"] is not None:
        raise app_error(410, "comment_deleted", "That comment was deleted.")
    post = post_repo.get_post(conn, comment["post_id"])
    if post is None or post["deleted_at"] is not None:
        raise app_error(410, "post_deleted", "That mog was deleted.")
    return comment, post


# ---- Representation ----------------------------------------------------------------

def comment_payload(comment, vote_row, viewer_player_id: Optional[str], post_owner_id: str) -> dict:
    return {
        "id": comment["id"],
        "postId": comment["post_id"],
        "seq": comment["seq"],
        "createdAt": iso(comment["created_at"]),
        "authorLabel": comment["author_label"],
        "body": comment["body"],
        "isPostAuthor": comment["author_player_id"] == post_owner_id,
        "mogScore": comment["mog_score"],
        "upCount": comment["up_count"],
        "downCount": comment["down_count"],
        "commentRevision": comment["revision"],
        "viewerVote": int(vote_row["value"]) if vote_row is not None else 0,
        "viewerVoteRevision": int(vote_row["revision"]) if vote_row is not None else 0,
        "isAuthor": viewer_player_id is not None and comment["author_player_id"] == viewer_player_id,
    }


def comment_vote_state(comment, vote_row) -> dict:
    return {
        "commentId": comment["id"],
        "mogScore": comment["mog_score"],
        "upCount": comment["up_count"],
        "downCount": comment["down_count"],
        "commentRevision": comment["revision"],
        "viewerVote": int(vote_row["value"]) if vote_row is not None else 0,
        "viewerVoteRevision": int(vote_row["revision"]) if vote_row is not None else 0,
    }


# ---- Reads -------------------------------------------------------------------------

def list_comments(db: Database, *, post_id: str, cursor: Optional[str], limit: int, viewer_player_id: Optional[str]) -> dict:
    """Oldest first (a conversation); votes never reorder. Keyset by `seq`."""
    after = 0
    if cursor:
        data = decode_cursor(cursor)
        if data.get("v") != 1 or data.get("f") != "comments" or data.get("p") != post_id:
            raise app_error(400, "invalid_cursor", "That page cursor is not valid.")
        after = cursor_int(data, "a")
    with db.read() as conn:
        post = _require_active_post(conn, post_id)
        rows = conn.execute(
            "SELECT * FROM social_comments WHERE post_id = ? AND deleted_at IS NULL AND seq > ? ORDER BY seq ASC LIMIT ?",
            (post_id, after, limit + 1),
        ).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        votes = _viewer_votes(conn, viewer_player_id, [r["id"] for r in rows])
        items = [comment_payload(r, votes.get(r["id"]), viewer_player_id, post["owner_player_id"]) for r in rows]
    next_cursor = encode_cursor({"v": 1, "f": "comments", "p": post_id, "a": rows[-1]["seq"]}) if more and rows else None
    return {"items": items, "nextCursor": next_cursor, "commentCount": post["comment_count"]}


def comments_created_since(db: Database, player_id: str, since: int) -> int:
    with db.read() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM social_comments WHERE author_player_id = ? AND created_at >= ?", (player_id, since)
        ).fetchone()
    return int(row["n"])


# ---- Create --------------------------------------------------------------------------

def _fingerprint(post_id: str, body: str) -> str:
    return hashlib.sha256(json.dumps({"p": post_id, "b": body}, ensure_ascii=False).encode()).hexdigest()


def _replay(conn, dedup, fingerprint: str, player_id: str) -> Optional[dict]:
    if dedup is None:
        return None
    if dedup["fingerprint"] != fingerprint:
        raise app_error(409, "idempotency_conflict", "That retry key was already used for a different comment.")
    comment = _get(conn, dedup["resource_id"])
    if comment is None or comment["deleted_at"] is not None:
        raise app_error(410, "comment_deleted", "That comment was deleted.")
    post = post_repo.get_post(conn, comment["post_id"])
    return comment_payload(comment, _get_vote(conn, comment["id"], player_id), player_id, post["owner_player_id"])


def create_comment(
    db: Database, *, post_id: str, player_id: str, idempotency_key: str, raw_body: str, retention_ms: int,
) -> tuple[dict, bool, int]:
    """Insert the comment, its author Up Mog, and the post's count in one transaction.

    Returns (comment, created, comment_count).
    """
    body = normalize_body(raw_body)
    fingerprint = _fingerprint(post_id, body)
    now = now_ms()
    with db.write() as conn:
        dedup = post_repo.get_dedup(conn, player_id, CREATE_OPERATION, idempotency_key, now)
        replay = _replay(conn, dedup, fingerprint, player_id)
        if replay is not None:
            post = post_repo.get_post(conn, post_id)
            return replay, False, post["comment_count"] if post else 0
        post = _require_active_post(conn, post_id)
        player = conn.execute("SELECT display_name FROM players WHERE id = ?", (player_id,)).fetchone()
        author = ((player["display_name"] if player else None) or "").strip() or "Anonymous"
        comment_id = secrets.token_urlsafe(9)
        conn.execute(
            "INSERT INTO social_comments (id, post_id, author_player_id, author_label, body, up_count, down_count, "
            "mog_score, revision, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, 1, 1, ?)",
            (comment_id, post_id, player_id, author, body, now),
        )
        conn.execute(
            "INSERT INTO social_comment_votes (comment_id, player_id, value, revision, created_at, updated_at) "
            "VALUES (?, ?, 1, 1, ?, ?)",
            (comment_id, player_id, now, now),
        )
        conn.execute("UPDATE social_posts SET comment_count = comment_count + 1 WHERE id = ?", (post_id,))
        post_repo.put_dedup(conn, player_id, CREATE_OPERATION, idempotency_key, fingerprint, comment_id, now, retention_ms)
        comment = _get(conn, comment_id)
        count = post_repo.get_post(conn, post_id)["comment_count"]
        payload = comment_payload(comment, _get_vote(conn, comment_id, player_id), player_id, post["owner_player_id"])
    return payload, True, count


# ---- Voting ----------------------------------------------------------------------

def set_comment_vote(db: Database, *, comment_id: str, player_id: str, value: int, expected_revision: int) -> dict:
    now = now_ms()
    with db.write() as conn:
        comment, _post = _require_active_comment(conn, comment_id)
        current = _get_vote(conn, comment_id, player_id)
        old_value = int(current["value"]) if current is not None else 0
        old_revision = int(current["revision"]) if current is not None else 0
        if old_value == value:
            return comment_vote_state(comment, current)
        if expected_revision != old_revision:
            raise ServiceError(
                409, "vote_conflict", "Your vote changed somewhere else. Here's the latest.", comment_vote_state(comment, current)
            )
        up_delta = int(value == 1) - int(old_value == 1)
        down_delta = int(value == -1) - int(old_value == -1)
        conn.execute(
            "INSERT INTO social_comment_votes (comment_id, player_id, value, revision, created_at, updated_at) "
            "VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (comment_id, player_id) DO UPDATE SET value = excluded.value, "
            "revision = social_comment_votes.revision + 1, updated_at = excluded.updated_at",
            (comment_id, player_id, value, now, now),
        )
        conn.execute(
            "UPDATE social_comments SET up_count = up_count + ?, down_count = down_count + ?, "
            "mog_score = mog_score + ? - ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL",
            (up_delta, down_delta, up_delta, down_delta, comment_id),
        )
        return comment_vote_state(_get(conn, comment_id), _get_vote(conn, comment_id, player_id))


# ---- Deletion --------------------------------------------------------------------

def delete_comment(db: Database, *, comment_id: str, player_id: str) -> int:
    """Author-only. Idempotent for the author. Returns the post's new comment count."""
    now = now_ms()
    with db.write() as conn:
        comment = _get(conn, comment_id)
        if comment is None:
            raise app_error(404, "comment_not_found", "That comment does not exist.")
        if comment["author_player_id"] != player_id:
            raise app_error(403, "comment_not_owned", "You can only delete your own comments.")
        post = post_repo.get_post(conn, comment["post_id"])
        if comment["deleted_at"] is not None:
            return post["comment_count"] if post else 0
        conn.execute("DELETE FROM social_comment_votes WHERE comment_id = ?", (comment_id,))
        conn.execute(
            "UPDATE social_comments SET deleted_at = ?, body = NULL, author_label = NULL, up_count = 0, down_count = 0, "
            "mog_score = 0, revision = revision + 1 WHERE id = ?",
            (now, comment_id),
        )
        conn.execute(
            "UPDATE social_posts SET comment_count = comment_count - 1 WHERE id = ? AND deleted_at IS NULL AND comment_count > 0",
            (comment["post_id"],),
        )
        post = post_repo.get_post(conn, comment["post_id"])
        return post["comment_count"]


# ---- Reconciliation ------------------------------------------------------------

def reconcile_comment_counts(conn) -> list[dict]:
    """Recompute comment vote counters and each post's comment_count."""
    fixes = []
    rows = conn.execute(
        "SELECT c.id, c.up_count, c.down_count, "
        "COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS up, "
        "COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS down "
        "FROM social_comments c LEFT JOIN social_comment_votes v ON v.comment_id = c.id "
        "WHERE c.deleted_at IS NULL GROUP BY c.id"
    ).fetchall()
    for row in rows:
        if row["up_count"] != row["up"] or row["down_count"] != row["down"]:
            conn.execute(
                "UPDATE social_comments SET up_count = ?, down_count = ?, mog_score = ?, revision = revision + 1 WHERE id = ?",
                (row["up"], row["down"], row["up"] - row["down"], row["id"]),
            )
            fixes.append({"commentId": row["id"], "to": [row["up"], row["down"]]})
    posts = conn.execute(
        "SELECT p.id, p.comment_count, (SELECT COUNT(*) FROM social_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS n "
        "FROM social_posts p WHERE p.deleted_at IS NULL"
    ).fetchall()
    for row in posts:
        if row["comment_count"] != row["n"]:
            conn.execute("UPDATE social_posts SET comment_count = ? WHERE id = ?", (row["n"], row["id"]))
            fixes.append({"postId": row["id"], "commentCount": row["n"]})
    return fixes
