"""Shared leaderboard: best server-recorded result per player and cohort.

Submissions send a result ID, never a score. Each result actually accepted into
the board (insert or confirmed higher-score replacement) is also written to
`leaderboard_publications` in the same transaction; that history is what makes
a result eligible to be shared as a mog.
"""

from __future__ import annotations

import re
import secrets
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from .db import iso, now_ms
from .errors import app_error, bad_request
from .http_utils import (
    check_mutation_origin,
    cursor_int,
    decode_cursor,
    encode_cursor,
    parse_limit,
    read_json_model,
    request_id,
)
from .sessions import require_viewer, resolve_viewer

router = APIRouter()

NAME_MIN, NAME_MAX = 2, 20
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def normalize_name(raw: str) -> str:
    return " ".join(raw.split())


class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    result_id: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=64)
    confirm_replace: bool = False


def _cohort(request: Request, model_version: Optional[str], display_map_version: Optional[str], capture_mode: Optional[str]) -> tuple[str, str, str]:
    app = request.app
    mv = model_version or app.state.manifest.model_version
    dm = display_map_version or app.state.display_map.version
    cm = capture_mode or "live"
    if cm not in ("live", "upload") or len(mv) > 200 or len(dm) > 100:
        raise bad_request("Unknown leaderboard cohort.")
    return mv, dm, cm


def _competition_rank(conn, cohort: tuple[str, str, str], score: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM leaderboard_entries WHERE model_version = ? AND display_map_version = ? "
        "AND capture_mode = ? AND score > ?",
        (*cohort, score),
    ).fetchone()
    return int(row["n"]) + 1


def _post_status(conn, result_id: str) -> dict:
    post = conn.execute("SELECT id, deleted_at FROM social_posts WHERE source_result_id = ?", (result_id,)).fetchone()
    if post is None:
        return {"postId": None, "postStatus": None}
    return {"postId": post["id"], "postStatus": "deleted" if post["deleted_at"] else "active"}


def _row_payload(conn, row, rank: int, viewer_player_id: Optional[str]) -> dict:
    mine = viewer_player_id is not None and row["player_id"] == viewer_player_id
    payload = {
        "entryId": row["id"],
        "rank": rank,
        "displayName": row["display_name"],
        "score": row["score"],
        "tier": row["tier"],
        "achievedAt": iso(row["achieved_at"]),
        "isMine": mine,
    }
    if mine:  # Ownership details only for the caller's own row.
        payload["resultId"] = row["result_id"]
        payload.update(_post_status(conn, row["result_id"]))
    return payload


@router.get("/v1/leaderboard")
async def list_leaderboard(
    request: Request,
    model_version: Optional[str] = None,
    display_map_version: Optional[str] = None,
    capture_mode: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: Optional[int] = None,
) -> JSONResponse:
    rid = request_id(request)
    cohort = _cohort(request, model_version, display_map_version, capture_mode)
    page_size = parse_limit(limit, 50, 100)
    viewer = resolve_viewer(request)
    viewer_id = viewer.player_id if viewer else None
    params: list = list(cohort)
    where = "model_version = ? AND display_map_version = ? AND capture_mode = ?"
    if cursor:
        data = decode_cursor(cursor)
        if data.get("v") != 1 or data.get("f") != "leaderboard":
            raise app_error(400, "invalid_cursor", "That page cursor is not valid.")
        score = cursor_int(data, "s", 0, 100)
        achieved = cursor_int(data, "a")
        entry_id = data.get("i")
        if not isinstance(entry_id, str) or len(entry_id) > 64:
            raise app_error(400, "invalid_cursor", "That page cursor is not valid.")
        where += " AND (score < ? OR (score = ? AND (achieved_at > ? OR (achieved_at = ? AND id > ?))))"
        params += [score, score, achieved, achieved, entry_id]
    with request.app.state.db.read() as conn:
        rows = conn.execute(
            f"SELECT * FROM leaderboard_entries WHERE {where} ORDER BY score DESC, achieved_at ASC, id ASC LIMIT ?",
            (*params, page_size + 1),
        ).fetchall()
        more = len(rows) > page_size
        rows = rows[:page_size]
        items = [_row_payload(conn, r, _competition_rank(conn, cohort, r["score"]), viewer_id) for r in rows]
        mine = None
        if viewer_id:
            own = conn.execute(
                "SELECT * FROM leaderboard_entries WHERE player_id = ? AND model_version = ? AND display_map_version = ? "
                "AND capture_mode = ?",
                (viewer_id, *cohort),
            ).fetchone()
            if own is not None:
                mine = _row_payload(conn, own, _competition_rank(conn, cohort, own["score"]), viewer_id)
    next_cursor = None
    if more and rows:
        last = rows[-1]
        next_cursor = encode_cursor({"v": 1, "f": "leaderboard", "s": last["score"], "a": last["achieved_at"], "i": last["id"]})
    return JSONResponse(
        {
            "cohort": {"modelVersion": cohort[0], "displayMapVersion": cohort[1], "captureMode": cohort[2]},
            "items": items,
            "nextCursor": next_cursor,
            "viewerEntry": mine,
            "request_id": rid,
        }
    )


def record_publication(conn, result_id: str, player_id: str, display_name: str, now: int) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO leaderboard_publications (result_id, player_id, display_name_snapshot, first_published_at) "
        "VALUES (?, ?, ?, ?)",
        (result_id, player_id, display_name, now),
    )


@router.post("/v1/leaderboard")
async def submit_leaderboard(request: Request) -> JSONResponse:
    rid = request_id(request)
    check_mutation_origin(request)
    viewer = require_viewer(request)
    body = await read_json_model(request, SubmitRequest)
    name = normalize_name(body.display_name)
    if not (NAME_MIN <= len(name) <= NAME_MAX) or _CONTROL.search(name):
        raise app_error(400, "invalid_display_name", "Use 2-20 characters for your display name.")
    now = now_ms()
    with request.app.state.db.write() as conn:
        result = conn.execute("SELECT * FROM scan_results WHERE id = ?", (body.result_id,)).fetchone()
        if result is None:
            raise app_error(404, "result_not_found", "That result does not exist.")
        if result["player_id"] != viewer.player_id:
            raise app_error(403, "result_not_owned", "You can only publish your own results.")
        if result["match_id"] is not None:
            raise app_error(409, "match_not_revealed", "Match results publish after the shared reveal.")
        cohort = (result["model_version"], result["display_map_version"], result["capture_mode"])
        existing = conn.execute(
            "SELECT * FROM leaderboard_entries WHERE player_id = ? AND model_version = ? AND display_map_version = ? "
            "AND capture_mode = ?",
            (viewer.player_id, *cohort),
        ).fetchone()
        conn.execute("UPDATE players SET display_name = ?, updated_at = ? WHERE id = ?", (name, now, viewer.player_id))
        if existing is None:
            entry_id = secrets.token_urlsafe(9)
            conn.execute(
                "INSERT INTO leaderboard_entries (id, player_id, result_id, display_name, score, tier, model_version, "
                "display_map_version, capture_mode, achieved_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (entry_id, viewer.player_id, result["id"], name, result["score"], result["tier"], *cohort,
                 result["created_at"], now),
            )
            record_publication(conn, result["id"], viewer.player_id, name, now)
            outcome = "inserted"
        elif existing["result_id"] == result["id"]:
            outcome = "unchanged"
        elif result["score"] <= existing["score"]:
            outcome = "not_higher"
        elif not body.confirm_replace:
            raise app_error(
                409,
                "replace_confirmation_required",
                f"Replace your shared {existing['score']} with {result['score']}?",
                {"currentScore": existing["score"], "newScore": result["score"]},
            )
        else:
            conn.execute(
                "UPDATE leaderboard_entries SET result_id = ?, display_name = ?, score = ?, tier = ?, achieved_at = ?, "
                "published_at = ? WHERE id = ?",
                (result["id"], name, result["score"], result["tier"], result["created_at"], now, existing["id"]),
            )
            record_publication(conn, result["id"], viewer.player_id, name, now)
            outcome = "replaced"
        entry = conn.execute(
            "SELECT * FROM leaderboard_entries WHERE player_id = ? AND model_version = ? AND display_map_version = ? "
            "AND capture_mode = ?",
            (viewer.player_id, *cohort),
        ).fetchone()
        payload = _row_payload(conn, entry, _competition_rank(conn, cohort, entry["score"]), viewer.player_id)
    return JSONResponse({"outcome": outcome, "entry": payload, "request_id": rid}, status_code=201 if outcome == "inserted" else 200)


@router.delete("/v1/leaderboard/me")
async def remove_my_entry(
    request: Request,
    model_version: Optional[str] = None,
    display_map_version: Optional[str] = None,
    capture_mode: Optional[str] = None,
) -> Response:
    """Remove only the caller's entry. Publication history and posts are kept."""
    check_mutation_origin(request)
    viewer = require_viewer(request)
    cohort = _cohort(request, model_version, display_map_version, capture_mode)
    with request.app.state.db.write() as conn:
        conn.execute(
            "DELETE FROM leaderboard_entries WHERE player_id = ? AND model_version = ? AND display_map_version = ? "
            "AND capture_mode = ?",
            (viewer.player_id, *cohort),
        )
    return Response(status_code=204)
