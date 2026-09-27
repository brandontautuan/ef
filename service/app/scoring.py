"""Shared inference path used by legacy `/v1/score` and registered scan frames.

Bytes are decoded in memory, scored, and released. Nothing image-derived is
persisted, cached, or logged.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import FastAPI, Request, UploadFile

from .config import settings
from .errors import invalid_image, payload_too_large, unavailable, unsupported_media
from .inference.preprocess import decode, preprocess


def run_inference(app: FastAPI, image_bytes: bytes) -> float:
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


async def read_image(request: Request, image: Optional[UploadFile]) -> bytes:
    """Content-type and size checks before any decode."""
    if image is None:
        raise invalid_image()
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
    if len(image_bytes) == 0:
        raise invalid_image()
    if len(image_bytes) > settings.max_image_bytes:
        raise payload_too_large()
    return image_bytes


async def score_bytes(app: FastAPI, image_bytes: bytes) -> float:
    """Admission control + deadlines around one inference."""
    admission = app.state.admission
    if not admission.try_reserve():
        raise unavailable()
    try:
        await asyncio.wait_for(admission.acquire(), timeout=settings.request_deadline_s)
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(run_inference, app, image_bytes),
                timeout=settings.inference_deadline_s,
            )
        finally:
            admission.release()
    except asyncio.TimeoutError:
        raise unavailable()
    finally:
        admission.release_reservation()
