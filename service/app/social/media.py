"""Post photo storage: owned-result copies, serving, and cleanup.

Post photos may only come from the caller's own result through its server-side
participant/media relationship, never from a client-supplied path or URL. This
repository keeps the no-persistence boundary for solo scans: solo scan crops
are never retained on the server, and the 1v1 match-media store does not exist
yet. `find_owned_source_photo` therefore returns None today, so every post
publishes as a structured result card. When match media lands, implement the
lookup there; the copy, attach, serve, and cleanup paths below already work.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..db import Database, now_ms

UNATTACHED_GRACE_MS = 60 * 60 * 1000


@dataclass(frozen=True)
class SourcePhoto:
    path: Path
    mime: str
    width: int
    height: int


def find_owned_source_photo(conn: sqlite3.Connection, player_id: str, result_id: str) -> Optional[SourcePhoto]:
    """Locate the caller's own retained photo for a result, if any.

    Must only ever return the current player's image for their own result,
    never an opponent's.
    """
    return None


def stage_copy(db: Database, media_dir: Path, player_id: str, source: SourcePhoto) -> str:
    """Copy outside any write transaction; returns a staged media ID.

    Staged rows have no attached post; cleanup removes them if publication fails.
    """
    media_id = secrets.token_urlsafe(12)
    relative = f"{media_id[:2]}/{media_id}"
    target = media_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    data = source.path.read_bytes()
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)
    with db.write() as conn:
        conn.execute(
            "INSERT INTO social_media (id, owner_player_id, relative_path, mime, byte_size, width, height, created_at, "
            "attached_post_id, delete_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
            (media_id, player_id, relative, source.mime, len(data), source.width, source.height, now_ms()),
        )
    return media_id


def attach(conn: sqlite3.Connection, media_id: str, post_id: str) -> None:
    conn.execute("UPDATE social_media SET attached_post_id = ? WHERE id = ?", (post_id, media_id))


def schedule_delete(conn: sqlite3.Connection, post_id: str, now: int) -> None:
    conn.execute(
        "UPDATE social_media SET delete_after = ? WHERE attached_post_id = ? AND delete_after IS NULL", (now, post_id)
    )


def mark_staged_for_cleanup(db: Database, media_id: str) -> None:
    with db.write() as conn:
        conn.execute("UPDATE social_media SET delete_after = ? WHERE id = ? AND attached_post_id IS NULL", (now_ms(), media_id))


def resolve_for_post(conn: sqlite3.Connection, media_dir: Path, post) -> Optional[tuple[Path, str]]:
    if post["media_id"] is None or post["deleted_at"] is not None:
        return None
    row = conn.execute(
        "SELECT relative_path, mime FROM social_media WHERE id = ? AND attached_post_id = ? AND delete_after IS NULL",
        (post["media_id"], post["id"]),
    ).fetchone()
    if row is None:
        return None
    path = (media_dir / row["relative_path"]).resolve()
    if media_dir.resolve() not in path.parents or not path.is_file():
        return None
    return path, row["mime"]


def cleanup(db: Database, media_dir: Path, now: Optional[int] = None) -> int:
    """Delete files for deleted posts and orphaned staged copies. Bounded per run."""
    now = now_ms() if now is None else now
    with db.read() as conn:
        rows = conn.execute(
            "SELECT id, relative_path FROM social_media WHERE (delete_after IS NOT NULL AND delete_after <= ?) "
            "OR (attached_post_id IS NULL AND created_at < ?) LIMIT 200",
            (now, now - UNATTACHED_GRACE_MS),
        ).fetchall()
    removed = 0
    for row in rows:
        path = media_dir / row["relative_path"]
        try:
            path.unlink(missing_ok=True)
        except OSError:
            continue
        with db.write() as conn:
            conn.execute("UPDATE social_posts SET media_id = NULL WHERE media_id = ?", (row["id"],))
            conn.execute("DELETE FROM social_media WHERE id = ?", (row["id"],))
        removed += 1
    return removed
