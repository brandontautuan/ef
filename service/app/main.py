"""Mog Scan rating service — stateless scoring API.

Implements `POST /v1/score` and `GET /health` exactly as specified in
`Mog_Scan_Service_Design_Doc.md`. The service is image-safe: bytes are decoded
in memory, scored, and released; nothing image-derived is persisted, cached, or
logged.
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .concurrency import Admission
from .config import settings
from .errors import (
    ServiceError,
    bad_request,
    invalid_image,
    payload_too_large,
    rate_limited,
    unavailable,
    unsupported_media,
)
from .inference.manifest import load_manifest
from .inference.model import build_runner
from .inference.preprocess import decode, preprocess
from .logging_utils import configure_logging, log_request
from .rate_limit import RateLimiter


def _new_request_id() -> str:
    return os.urandom(12).hex()


def _error_response(err: ServiceError, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=err.status_code,
        content={
            "error": {"code": err.code, "message": err.message},
            "request_id": request_id,
        },
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    app.state.manifest = load_manifest(settings.model_dir)
    app.state.runner = build_runner(app.state.manifest)
    app.state.admission = Admission(settings.max_concurrency, settings.max_queue)
    app.state.rate_limiter = RateLimiter(
        settings.rate_limit_requests, settings.rate_limit_window_s
    )
    yield


app = FastAPI(title="Mog Scan rating service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)


@app.exception_handler(ServiceError)
async def _service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or _new_request_id()
    return _error_response(exc, request_id)


@app.exception_handler(StarletteHTTPException)
async def _http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or _new_request_id()
    # Map framework errors onto our stable schema without leaking detail.
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


def _client_ip(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _run_inference(image_bytes: bytes) -> float:
    """Decode -> preprocess -> score. Runs in a worker thread. No persistence."""
    manifest = app.state.manifest
    img = decode(image_bytes, settings.max_image_pixels)
    try:
        buffer = preprocess(img, manifest)
    finally:
        img.close()
    native = app.state.runner.score(buffer)
    if not isinstance(native, (int, float)) or native != native or native in (
        float("inf"),
        float("-inf"),
    ):
        raise invalid_image()  # non-finite model output -> treat as unusable
    native = float(native)
    if not manifest.in_range(native):
        # Output outside the declared native range is a model/version fault.
        raise unavailable()
    return native


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
        if image.content_type not in settings.allowed_content_types:
            raise unsupported_media()

        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > settings.max_image_bytes + 4096:
                    raise payload_too_large()
            except ValueError:
                pass  # fall through to the read-time check

        image_bytes = await image.read()
        payload_bytes = len(image_bytes)
        if payload_bytes == 0:
            raise invalid_image()
        if payload_bytes > settings.max_image_bytes:
            raise payload_too_large()

        # --- Admission control: shed load rather than exhaust workers. ---
        if not app.state.admission.try_reserve():
            raise unavailable()
        try:
            await asyncio.wait_for(
                app.state.admission.acquire(), timeout=settings.request_deadline_s
            )
            try:
                native = await asyncio.wait_for(
                    asyncio.to_thread(_run_inference, image_bytes),
                    timeout=settings.inference_deadline_s,
                )
            finally:
                app.state.admission.release()
        except asyncio.TimeoutError:
            raise unavailable()
        finally:
            app.state.admission.release_reservation()
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
