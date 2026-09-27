"""SQLite access for durable application data.

One short-lived connection per request/worker. Every connection enables foreign
keys, WAL, and a bounded busy timeout. Writes use `BEGIN IMMEDIATE` so the
write lock is taken up front and never held while waiting on inference or
network calls. Migrations are forward-only SQL files applied at startup.
"""

from __future__ import annotations

import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
BUSY_TIMEOUT_MS = 5_000
_MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int | None) -> str | None:
    """Render a stored UTC millisecond timestamp as ISO-8601."""
    if ms is None:
        return None
    seconds, millis = divmod(int(ms), 1000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(seconds)) + f".{millis:03d}Z"


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = connect(self.path)
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """A short write transaction. Commits on success, rolls back on any error."""
        conn = connect(self.path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    def migrate(self, migrations_dir: Path = MIGRATIONS_DIR) -> list[str]:
        """Apply pending forward-only migrations. Never recreates the database."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        applied: list[str] = []
        conn = connect(self.path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
            )
            done = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations")}
            for file in sorted(migrations_dir.glob("*.sql")):
                if not _MIGRATION_NAME.match(file.name):
                    continue
                version = file.stem
                if version in done:
                    continue
                sql = file.read_text()
                script = (
                    "BEGIN IMMEDIATE;\n"
                    + sql
                    + f"\nINSERT INTO schema_migrations (version, applied_at) VALUES ('{version}', {now_ms()});\nCOMMIT;"
                )
                try:
                    conn.executescript(script)
                except Exception:
                    if conn.in_transaction:
                        conn.execute("ROLLBACK")
                    raise
                applied.append(version)
        finally:
            conn.close()
        return applied

    def backup(self, destination: Path) -> None:
        """Consistent snapshot using SQLite's backup API (safe with WAL writers)."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        src = connect(self.path)
        dst = sqlite3.connect(str(destination))
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
