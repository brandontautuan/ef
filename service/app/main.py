"""Mog Scan service: scoring API plus shared sessions, leaderboard, and social.

The legacy `POST /v1/score` and `GET /health` routes behave exactly as specified
in `Mog_Scan_Service_Design_Doc.md` and stay image-safe: bytes are decoded in
memory, scored, and released; nothing image-derived is persisted, cached, or
logged. Registered scans, the shared leaderboard, and the anonymous social
system store only completed result records, posts, and votes in SQLite.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import leaderboard, scans, sessions
from .concurrency import Admission
from .config import settings
from .db import Database, now_ms
from .display_score import get_display_map
from .errors import ServiceError, bad_request, rate_limited, unavailable
from .http_utils import new_request_id as _new_request_id
from .inference.manifest import load_manifest
from .inference.model import build_runner
from .logging_utils import configure_logging, log_request, logger
from .rate_limit import RateLimiter
from .scoring import read_image, score_bytes
from .social import media as social_media
from .social.router import router as social_router

# Responses from these prefixes can carry viewer-specific data (session state,
# viewerVote, isOwner). They must never be stored by a shared cache.
PRIVATE_PREFIXES = ("/v1/session", "/v1/social", "/v1/leaderboard", "/v1/scans")


def _error_response(err: ServiceError, request_id: str) -> JSONResponse:
    error: dict = {"code": err.code, "message": err.message}
    if err.details is not None:
        error["details"] = err.details
    return JSONResponse(
        status_code=err.status_code,
        content={"error": error, "request_id": request_id},
        headers=err.headers,
    )


def run_maintenance(app: FastAPI) -> dict:
    """Expire sessions and idempotency records; clean up post media and scans."""
    db: Database = app.state.db
    now = now_ms()
    with db.write() as conn:
        sessions_removed = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,)).rowcount
        dedup_removed = conn.execute("DELETE FROM request_deduplication WHERE expires_at <= ?", (now,)).rowcount
    media_removed = social_media.cleanup(db, app.state.post_media_dir, now)
    app.state.scans.sweep()
    for limiter in (app.state.rate_limiter, app.state.session_create_limiter, app.state.post_limiter, app.state.vote_limiter, app.state.comment_limiter):
        limiter.sweep()
    return {"sessions": sessions_removed, "dedup": dedup_removed, "media": media_removed}


async def _maintenance_loop(app: FastAPI) -> None:
    while True:
        await asyncio.sleep(settings.maintenance_interval_s)
        try:
            await asyncio.to_thread(run_maintenance, app)
        except Exception:  # keep the service up; never log row contents
            logger.warning("maintenance run failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    app.state.manifest = load_manifest(settings.model_dir)
    app.state.calibration = json.loads((settings.model_dir / "calibration.json").read_text())
    if app.state.calibration.get("modelVersion") != app.state.manifest.model_version:
        raise RuntimeError("Calibration modelVersion must match the active model manifest.")
    app.state.runner = build_runner(app.state.manifest, settings.model_dir)
    app.state.admission = Admission(settings.max_concurrency, settings.max_queue)
    app.state.rate_limiter = RateLimiter(
        settings.rate_limit_requests, settings.rate_limit_window_s
    )
    # Shared application data. Tests may point these at temporary locations.
    db_path = getattr(app.state, "db_path_override", None) or settings.database_path
    app.state.db = Database(db_path)
    app.state.db.migrate()  # forward-only, before admitting traffic
    app.state.post_media_dir = getattr(app.state, "post_media_dir_override", None) or settings.post_media_dir
    app.state.display_map = get_display_map(settings.display_map)
    app.state.scans = scans.ScanRegistry(settings.scan_session_ttl_s)
    app.state.session_create_limiter = RateLimiter(settings.session_create_per_hour, 3600.0)
    app.state.post_limiter = RateLimiter(settings.posts_per_minute, 60.0)
    app.state.vote_limiter = RateLimiter(settings.votes_per_minute, 60.0)
    app.state.comment_limiter = RateLimiter(settings.comments_per_minute, 60.0)
    maintenance = asyncio.create_task(_maintenance_loop(app))
    try:
        yield
    finally:
        maintenance.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await maintenance


app = FastAPI(title="Mog Scan rating service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)


@app.middleware("http")
async def _private_responses(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(PRIVATE_PREFIXES):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Cookie"
    token = getattr(request.state, "renew_cookie_token", None)
    if token and not any(
        h.startswith(sessions.cookie_name().encode() + b"=") for k, h in response.raw_headers if k == b"set-cookie"
    ):
        sessions.set_session_cookie(response, token)  # rolling renewal, at most daily
    return response


app.include_router(sessions.router)
app.include_router(scans.router)
app.include_router(leaderboard.router)
app.include_router(social_router)


@app.exception_handler(ServiceError)
async def _service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or _new_request_id()
    return _error_response(exc, request_id)


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or _new_request_id()
    return _error_response(bad_request(), request_id)


@app.exception_handler(StarletteHTTPException)
async def _http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or _new_request_id()
    # Map framework errors onto our stable schema without leaking detail.
    if exc.status_code == 404:
        err = ServiceError(404, "not_found", "Not found.")
    elif exc.status_code == 405:
        err = ServiceError(405, "method_not_allowed", "Method not allowed.")
    else:
        err = bad_request() if exc.status_code < 500 else unavailable()
    return _error_response(err, request_id)


@app.exception_handler(Exception)
async def _unexpected_handler(request: Request, exc: Exception) -> JSONResponse:
    # Never leak stack traces or internals. Generic 503.
    request_id = getattr(request.state, "request_id", None) or _new_request_id()
    return _error_response(unavailable(), request_id)


@app.get("/health")
async def health() -> dict:
    manifest = app.state.manifest
    return {"status": "ok", "model_version": manifest.model_version}


@app.get("/v1/calibration")
async def calibration() -> dict:
    """Public, versioned display mapping; contains no user or image data."""
    return app.state.calibration


def _client_ip(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


@app.post("/v1/score")
async def score(
    request: Request,
    image: Optional[UploadFile] = File(default=None),
    scan_id: Optional[str] = Form(default=None),
    frame_sequence: Optional[str] = Form(default=None),
) -> JSONResponse:
    request_id = _new_request_id()
    request.state.request_id = request_id
    manifest = app.state.manifest
    started = time.perf_counter()
    payload_bytes: Optional[int] = None
    status_code = 200
    error_code: Optional[str] = None

    try:
        # --- Rate limit first (cheap, before any body work). ---
        if not app.state.rate_limiter.allow(_client_ip(request)):
            raise rate_limited()

        # --- Validate metadata before decoding anything. ---
        if scan_id is None or frame_sequence is None or image is None:
            raise bad_request("Missing image, scan_id, or frame_sequence.")
        if len(scan_id) == 0 or len(scan_id) > settings.max_scan_id_len:
            raise bad_request("Invalid scan_id.")
        try:
            seq = int(frame_sequence)
        except (TypeError, ValueError):
            raise bad_request("frame_sequence must be an integer.")
        if seq < 0:
            raise bad_request("frame_sequence must be non-negative.")

        # --- Content type + size limits before decode. ---
        image_bytes = await read_image(request, image)
        payload_bytes = len(image_bytes)
        try:
            # Admission control sheds load rather than exhausting workers.
            native = await score_bytes(app, image_bytes)
        finally:
            del image_bytes  # release image memory immediately

        return JSONResponse(
            status_code=200,
            content={
                "native_score": native,
                "model_version": manifest.model_version,
                "request_id": request_id,
            },
        )

    except ServiceError as err:
        status_code = err.status_code
        error_code = err.code
        return _error_response(err, request_id)
    except Exception:
        status_code = 503
        error_code = "unavailable"
        return _error_response(unavailable(), request_id)
    finally:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        log_request(
            request_id=request_id,
            status_code=status_code,
            elapsed_ms=elapsed_ms,
            model_version=manifest.model_version,
            payload_bytes=payload_bytes,
            error_code=error_code,
        )
