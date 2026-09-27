"""Parameterized SQL for posts, votes, counters, and keyset pagination."""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional

Row = sqlite3.Row


def get_post(conn: sqlite3.Connection, post_id: str) -> Optional[Row]:
    return conn.execute("SELECT * FROM social_posts WHERE id = ?", (post_id,)).fetchone()


def get_post_by_result(conn: sqlite3.Connection, result_id: str) -> Optional[Row]:
    return conn.execute("SELECT * FROM social_posts WHERE source_result_id = ?", (result_id,)).fetchone()


def get_result(conn: sqlite3.Connection, result_id: str) -> Optional[Row]:
    return conn.execute("SELECT * FROM scan_results WHERE id = ?", (result_id,)).fetchone()


def get_publication(conn: sqlite3.Connection, result_id: str) -> Optional[Row]:
    return conn.execute("SELECT * FROM leaderboard_publications WHERE result_id = ?", (result_id,)).fetchone()


def insert_post(
    conn: sqlite3.Connection,
    *,
    post_id: str,
    owner_player_id: str,
    result: Row,
    author_label: str,
    caption: Optional[str],
    media_id: Optional[str],
    now: int,
) -> None:
    conn.execute(
        "INSERT INTO social_posts (id, owner_player_id, source_result_id, author_label, scan_score, tier, model_version, "
        "display_map_version, capture_mode, result_created_at, caption, media_id, up_count, down_count, mog_score, "
        "revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 1, ?)",
        (
            post_id, owner_player_id, result["id"], author_label, result["score"], result["tier"],
            result["model_version"], result["display_map_version"], result["capture_mode"], result["created_at"],
            caption, media_id, now,
        ),
    )


def insert_vote(conn: sqlite3.Connection, post_id: str, player_id: str, value: int, revision: int, now: int) -> None:
    conn.execute(
        "INSERT INTO social_votes (post_id, player_id, value, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (post_id, player_id, value, revision, now, now),
    )


def get_vote(conn: sqlite3.Connection, post_id: str, player_id: str) -> Optional[Row]:
    return conn.execute(
        "SELECT value, revision FROM social_votes WHERE post_id = ? AND player_id = ?", (post_id, player_id)
    ).fetchone()


def upsert_vote(conn: sqlite3.Connection, post_id: str, player_id: str, value: int, now: int) -> int:
    """Set the vote and increment its revision; returns the new revision."""
    conn.execute(
        "INSERT INTO social_votes (post_id, player_id, value, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) "
        "ON CONFLICT (post_id, player_id) DO UPDATE SET value = excluded.value, revision = social_votes.revision + 1, "
        "updated_at = excluded.updated_at",
        (post_id, player_id, value, now, now),
    )
    return int(get_vote(conn, post_id, player_id)["revision"])


def apply_count_deltas(conn: sqlite3.Connection, post_id: str, up_delta: int, down_delta: int) -> None:
    conn.execute(
        "UPDATE social_posts SET up_count = up_count + ?, down_count = down_count + ?, "
        "mog_score = mog_score + ? - ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL",
        (up_delta, down_delta, up_delta, down_delta, post_id),
    )


def viewer_votes(conn: sqlite3.Connection, player_id: str, post_ids: Iterable[str]) -> dict[str, Row]:
    ids = list(dict.fromkeys(post_ids))
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT post_id, value, revision FROM social_votes WHERE player_id = ? AND post_id IN ({marks})",
        (player_id, *ids),
    ).fetchall()
    return {row["post_id"]: row for row in rows}


def posts_by_ids(conn: sqlite3.Connection, post_ids: list[str]) -> dict[str, Row]:
    if not post_ids:
        return {}
    marks = ",".join("?" for _ in post_ids)
    rows = conn.execute(f"SELECT * FROM social_posts WHERE id IN ({marks})", post_ids).fetchall()
    return {row["id"]: row for row in rows}


def max_active_seq(conn: sqlite3.Connection, owner_player_id: Optional[str] = None) -> int:
    if owner_player_id is None:
        row = conn.execute("SELECT MAX(feed_seq) AS m FROM social_posts WHERE deleted_at IS NULL").fetchone()
    else:
        row = conn.execute(
            "SELECT MAX(feed_seq) AS m FROM social_posts WHERE deleted_at IS NULL AND owner_player_id = ?",
            (owner_player_id,),
        ).fetchone()
    return int(row["m"] or 0)


def feed_page(
    conn: sqlite3.Connection,
    snapshot_max_seq: int,
    before_seq: Optional[int],
    limit: int,
    owner_player_id: Optional[str] = None,
) -> list[Row]:
    clauses = ["deleted_at IS NULL", "feed_seq <= ?"]
    params: list = [snapshot_max_seq]
    if before_seq is not None:
        clauses.append("feed_seq < ?")
        params.append(before_seq)
    if owner_player_id is not None:
        clauses.append("owner_player_id = ?")
        params.append(owner_player_id)
    params.append(limit)
    return conn.execute(
        f"SELECT * FROM social_posts WHERE {' AND '.join(clauses)} ORDER BY feed_seq DESC LIMIT ?", params
    ).fetchall()


def upmog_page(
    conn: sqlite3.Connection,
    player_id: str,
    before: Optional[tuple[int, str]],
    limit: int,
) -> list[Row]:
    params: list = [player_id]
    extra = ""
    if before is not None:
        extra = " AND (v.updated_at < ? OR (v.updated_at = ? AND v.post_id < ?))"
        params += [before[0], before[0], before[1]]
    params.append(limit)
    return conn.execute(
        "SELECT p.*, v.updated_at AS vote_updated_at FROM social_votes v JOIN social_posts p ON p.id = v.post_id "
        f"WHERE v.player_id = ? AND v.value = 1 AND p.deleted_at IS NULL{extra} "
        "ORDER BY v.updated_at DESC, v.post_id DESC LIMIT ?",
        params,
    ).fetchall()


def count_newer(conn: sqlite3.Connection, after_seq: int, cap: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM (SELECT 1 FROM social_posts WHERE deleted_at IS NULL AND feed_seq > ? LIMIT ?)",
        (after_seq, cap + 1),
    ).fetchone()
    return int(row["n"])


def posts_created_since(conn: sqlite3.Connection, owner_player_id: str, since: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM social_posts WHERE owner_player_id = ? AND created_at >= ?", (owner_player_id, since)
    ).fetchone()
    return int(row["n"])


def tombstone(conn: sqlite3.Connection, post_id: str, now: int) -> None:
    """Keep only ID, source result, owner, feed sequence, and deletion time."""
    conn.execute("DELETE FROM social_votes WHERE post_id = ?", (post_id,))
    conn.execute(
        "UPDATE social_posts SET deleted_at = ?, caption = NULL, media_id = NULL, author_label = NULL, scan_score = NULL, "
        "tier = NULL, model_version = NULL, display_map_version = NULL, capture_mode = NULL, result_created_at = NULL, "
        "up_count = 0, down_count = 0, mog_score = 0, revision = revision + 1 WHERE id = ?",
        (now, post_id),
    )


def shareable_results_page(
    conn: sqlite3.Connection,
    player_id: str,
    before: Optional[tuple[int, str]],
    limit: int,
) -> list[Row]:
    params: list = [player_id]
    extra = ""
    if before is not None:
        extra = " AND (lp.first_published_at < ? OR (lp.first_published_at = ? AND lp.result_id < ?))"
        params += [before[0], before[0], before[1]]
    params.append(limit)
    return conn.execute(
        "SELECT lp.result_id, lp.display_name_snapshot, lp.first_published_at, r.score, r.tier, r.model_version, "
        "r.display_map_version, r.capture_mode, r.created_at AS result_created_at, r.match_id, "
        "p.id AS post_id, p.deleted_at AS post_deleted_at "
        "FROM leaderboard_publications lp JOIN scan_results r ON r.id = lp.result_id "
        "LEFT JOIN social_posts p ON p.source_result_id = lp.result_id "
        f"WHERE lp.player_id = ?{extra} ORDER BY lp.first_published_at DESC, lp.result_id DESC LIMIT ?",
        params,
    ).fetchall()


# ---- Idempotency records ----------------------------------------------------

def get_dedup(conn: sqlite3.Connection, player_id: str, operation: str, key: str, now: int) -> Optional[Row]:
    return conn.execute(
        "SELECT * FROM request_deduplication WHERE player_id = ? AND operation = ? AND idempotency_key = ? "
        "AND expires_at > ?",
        (player_id, operation, key, now),
    ).fetchone()


def put_dedup(
    conn: sqlite3.Connection, player_id: str, operation: str, key: str, fingerprint: str, resource_id: str, now: int,
    retention_ms: int,
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO request_deduplication (player_id, operation, idempotency_key, fingerprint, resource_id, "
        "created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (player_id, operation, key, fingerprint, resource_id, now, now + retention_ms),
    )


# ---- Counter reconciliation --------------------------------------------------

def reconcile_counts(conn: sqlite3.Connection) -> list[dict]:
    """Recompute active-post counters from vote rows; repair and report drift."""
    rows = conn.execute(
        "SELECT p.id, p.up_count, p.down_count, p.mog_score, "
        "COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS up, "
        "COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS down "
        "FROM social_posts p LEFT JOIN social_votes v ON v.post_id = p.id "
        "WHERE p.deleted_at IS NULL GROUP BY p.id"
    ).fetchall()
    fixes = []
    for row in rows:
        if row["up_count"] != row["up"] or row["down_count"] != row["down"] or row["mog_score"] != row["up"] - row["down"]:
            conn.execute(
                "UPDATE social_posts SET up_count = ?, down_count = ?, mog_score = ?, revision = revision + 1 WHERE id = ?",
                (row["up"], row["down"], row["up"] - row["down"], row["id"]),
            )
            fixes.append({"postId": row["id"], "from": [row["up_count"], row["down_count"]], "to": [row["up"], row["down"]]})
    return fixes
