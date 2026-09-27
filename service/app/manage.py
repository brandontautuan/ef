"""Operator commands for the shared database.

    python -m app.manage migrate
    python -m app.manage backup data/backups/mog-YYYYmmdd.sqlite3
    python -m app.manage reconcile-votes
    python -m app.manage cleanup-media

Run these against the same DATABASE_PATH / POST_MEDIA_DIR as the service.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import settings
from .db import Database
from .social import media
from .social.repository import reconcile_counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.manage")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="apply pending forward-only migrations")
    backup = sub.add_parser("backup", help="consistent snapshot via the SQLite backup API")
    backup.add_argument("destination", type=Path)
    sub.add_parser("reconcile-votes", help="recompute active-post counters from vote rows under a write lock")
    sub.add_parser("cleanup-media", help="delete files for deleted posts and orphaned staged copies")
    args = parser.parse_args(argv)

    db = Database(settings.database_path)
    if args.command == "migrate":
        print(json.dumps({"applied": db.migrate()}))
    elif args.command == "backup":
        db.backup(args.destination)
        print(json.dumps({"backup": str(args.destination)}))
    elif args.command == "reconcile-votes":
        with db.write() as conn:
            fixes = reconcile_counts(conn)
        print(json.dumps({"repaired": len(fixes), "posts": fixes}))
    elif args.command == "cleanup-media":
        print(json.dumps({"removed": media.cleanup(db, settings.post_media_dir)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
