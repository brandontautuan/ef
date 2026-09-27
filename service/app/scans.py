"""Registered scans: the backend, not the browser, computes shared results.

A client registers an owned scan, uploads selected crops one frame at a time,
and the service finalizes a `scan_results` row after the required frames
(three for live camera, one for photo upload). Incomplete scans live only in a
bounded, expiring in-memory registry; frame images and per-frame native scores
are never persisted.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .config import settings
from .db import iso, now_ms
from .display_score import get_display_map, median, tier_for
from .errors import app_error, bad_request, rate_limited
from .http_utils import check_mutation_origin, network_key, read_json_model, request_id
from .scoring import read_image, score_bytes
from .sessions import require_viewer

router = APIRouter()

REQUIRED_FRAMES = {"live": 3, "upload": 1}
MAX_SCANS_PER_PLAYER = 4


class CreateScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    capture_mode: Literal["live", "upload"]


@dataclass
class ScanSession:
    id: str
    player_id: str
    capture_mode: str
    required: int
    model_version: str
    display_map_version: str
    created_at: float
    frames: dict[int, float] = field(default_factory=dict)
    attempts: int = 0
    result: Optional[dict] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ScanRegistry:
    def __init__(self, ttl_s: int) -> None:
        self._ttl = ttl_s
        self._scans: dict[str, ScanSession] = {}

    def create(self, player_id: str, capture_mode: str, model_version: str, display_map_version: str) -> ScanSession:
        self.sweep()
        mine = sorted((s for s in self._scans.values() if s.player_id == player_id), key=lambda s: s.created_at)
        for old in mine[: max(0, len(mine) - MAX_SCANS_PER_PLAYER + 1)]:
            self._scans.pop(old.id, None)
        scan = ScanSession(
            id=secrets.token_urlsafe(12),
            player_id=player_id,
            capture_mode=capture_mode,
            required=REQUIRED_FRAMES[capture_mode],
            model_version=model_version,
            display_map_version=display_map_version,
            created_at=time.monotonic(),
        )
        self._scans[scan.id] = scan
        return scan

    def get(self, scan_id: str, player_id: str) -> Optional[ScanSession]:
        scan = self._scans.get(scan_id)
        if scan is None or scan.player_id != player_id:
            return None
        if time.monotonic() - scan.created_at > self._ttl:
            self._scans.pop(scan_id, None)
            return None
        return scan

    def drop(self, scan_id: str) -> None:
        self._scans.pop(scan_id, None)

    def sweep(self) -> None:
        cutoff = time.monotonic() - self._ttl
        for key in [k for k, s in self._scans.items() if s.created_at < cutoff]:
            self._scans.pop(key, None)

    def __len__(self) -> int:
        return len(self._scans)


def result_payload(row) -> dict:
    return {
        "id": row["id"],
        "score": row["score"],
        "tier": row["tier"],
        "modelVersion": row["model_version"],
        "displayMapVersion": row["display_map_version"],
        "captureMode": row["capture_mode"],
        "createdAt": iso(row["created_at"]),
    }


@router.post("/v1/scans")
async def create_scan(request: Request) -> JSONResponse:
    rid = request_id(request)
    check_mutation_origin(request)
    viewer = require_viewer(request)
    body = await read_json_model(request, CreateScanRequest)
    app = request.app
    scan = app.state.scans.create(
        viewer.player_id,
        body.capture_mode,
        app.state.manifest.model_version,
        app.state.display_map.version,
    )
    return JSONResponse(
        {
            "scan_id": scan.id,
            "capture_mode": scan.capture_mode,
            "required_frames": scan.required,
            "model_version": scan.model_version,
            "display_map_version": scan.display_map_version,
            "request_id": rid,
        },
        status_code=201,
    )


@router.post("/v1/scans/{scan_id}/frames")
async def submit_frame(
    request: Request,
    scan_id: str,
    image: Optional[UploadFile] = File(default=None),
    frame_sequence: Optional[str] = Form(default=None),
) -> JSONResponse:
    rid = request_id(request)
    check_mutation_origin(request)
    viewer = require_viewer(request)
    app = request.app
    if not app.state.rate_limiter.allow(network_key(request)):
        raise rate_limited()
    try:
        seq = int(frame_sequence) if frame_sequence is not None else -1
    except ValueError:
        seq = -1
    if seq < 0 or seq > 10_000:
        raise bad_request("frame_sequence must be a non-negative integer.")
    scan = app.state.scans.get(scan_id, viewer.player_id)
    if scan is None:
        raise app_error(404, "scan_not_found", "That scan expired or does not exist. Start a new scan.")

    async with scan.lock:
        if scan.result is None and seq not in scan.frames:
            if scan.attempts >= settings.max_frames_per_scan:
                app.state.scans.drop(scan.id)
                raise app_error(409, "scan_exhausted", "Too many frames for one scan. Start a new scan.")
            if app.state.manifest.model_version != scan.model_version:
                app.state.scans.drop(scan.id)
                raise app_error(409, "model_changed", "The model changed during this scan. Please scan again.")
            scan.attempts += 1
            image_bytes = await read_image(request, image)
            try:
                native = await score_bytes(app, image_bytes)
            finally:
                del image_bytes
            scan.frames[seq] = native
            if len(scan.frames) >= scan.required and scan.result is None:
                scan.result = _finalize(app, scan)
        # A repeated sequence returns its cached acknowledgment without rescoring.
        payload = {
            "scan_id": scan.id,
            "frame_sequence": seq,
            "accepted_frames": min(len(scan.frames), scan.required),
            "required_frames": scan.required,
            "status": "complete" if scan.result else "collecting",
            "native_score": scan.frames.get(seq),
            "model_version": scan.model_version,
            "result": scan.result,
            "request_id": rid,
        }
    return JSONResponse(payload)


def _finalize(app, scan: ScanSession) -> dict:
    natives = [scan.frames[k] for k in sorted(scan.frames)][: scan.required]
    display_map = get_display_map(scan.display_map_version)
    score = display_map.score(median(natives))
    tier = tier_for(score)
    result_id = secrets.token_urlsafe(12)
    now = now_ms()
    with app.state.db.write() as conn:
        conn.execute(
            "INSERT INTO scan_results (id, player_id, match_id, capture_mode, score, tier, model_version, "
            "display_map_version, frame_count, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
            (result_id, scan.player_id, scan.capture_mode, score, tier, scan.model_version,
             scan.display_map_version, len(natives), now),
        )
        row = conn.execute("SELECT * FROM scan_results WHERE id = ?", (result_id,)).fetchone()
    return result_payload(row)

