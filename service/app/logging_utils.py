"""Image-safe request logging.

Per the design doc, logs may contain only: request_id, status class, elapsed
time, model version, payload byte bucket, and a coarse error code. They must
never contain raw bodies, data URLs, image paths, decoded pixels, embeddings,
scores tied to identifiers, or exception dumps.

The helpers here are the *only* sanctioned way to emit per-request logs, so the
excluded fields simply have nowhere to enter.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("mogscan.rating")


def configure_logging(level: int = logging.INFO) -> None:
    if logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(level)


def byte_bucket(n: int) -> str:
    """Coarsen a payload size so exact bytes are not logged."""
    if n < 64 * 1024:
        return "<64KiB"
    if n < 256 * 1024:
        return "64-256KiB"
    if n < 1024 * 1024:
        return "256KiB-1MiB"
    if n < 3 * 1024 * 1024:
        return "1-3MiB"
    return ">=3MiB"


def status_class(status_code: int) -> str:
    return f"{status_code // 100}xx"


def log_request(
    *,
    request_id: str,
    status_code: int,
    elapsed_ms: float,
    model_version: str,
    payload_bytes: int | None,
    error_code: str | None = None,
) -> None:
    """Emit exactly the allowed, non-sensitive fields for one request."""
    logger.info(
        "req id=%s status=%s(%d) elapsed_ms=%.1f model=%s bytes=%s error=%s",
        request_id,
        status_class(status_code),
        status_code,
        elapsed_ms,
        model_version,
        byte_bucket(payload_bytes) if payload_bytes is not None else "n/a",
        error_code or "-",
    )
