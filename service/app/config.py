"""Runtime configuration for the Mog Scan rating service.

All limits and deadlines are read from the environment so a deployment can tune
them without code changes. Defaults are intentionally conservative and, per the
service design doc, the request/inference deadlines stay well under the client's
overall scan timeout (8s per request).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


def _origins(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return default
    return [o.strip() for o in raw.split(",") if o.strip()]


@dataclass(frozen=True)
class Settings:
    # Where the active model package lives (manifest.yaml + calibration.json).
    model_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get(
                "MODEL_DIR",
                str(Path(__file__).resolve().parent.parent / "models" / "mock-ui-v1"),
            )
        )
    )

    # Payload bounds. Validated BEFORE the image is decoded.
    max_image_bytes: int = field(default_factory=lambda: _int("MAX_IMAGE_BYTES", 3 * 1024 * 1024))
    # Decompression-bomb defense: cap decoded pixel count regardless of file size.
    max_image_pixels: int = field(default_factory=lambda: _int("MAX_IMAGE_PIXELS", 4_000_000))
    allowed_content_types: tuple[str, ...] = ("image/jpeg", "image/webp")

    # Metadata bounds.
    max_scan_id_len: int = field(default_factory=lambda: _int("MAX_SCAN_ID_LEN", 128))

    # Deadlines (seconds). Kept below the client's 8s per-request abort.
    request_deadline_s: float = field(default_factory=lambda: _float("REQUEST_DEADLINE_S", 5.0))
    inference_deadline_s: float = field(default_factory=lambda: _float("INFERENCE_DEADLINE_S", 4.0))
    decode_deadline_s: float = field(default_factory=lambda: _float("DECODE_DEADLINE_S", 2.0))

    # Bounded inference: at most `max_concurrency` in flight; at most
    # `max_queue` additional requests waiting. Beyond that we shed with 503.
    max_concurrency: int = field(default_factory=lambda: _int("MAX_CONCURRENCY", 4))
    max_queue: int = field(default_factory=lambda: _int("MAX_QUEUE", 16))

    # Rate limiting per privacy-preserving network key.
    rate_limit_requests: int = field(default_factory=lambda: _int("RATE_LIMIT_REQUESTS", 60))
    rate_limit_window_s: float = field(default_factory=lambda: _float("RATE_LIMIT_WINDOW_S", 60.0))

    # CORS: exact deployed client origins. Dev default is the Vite server.
    cors_origins: list[str] = field(
        default_factory=lambda: _origins("CORS_ORIGINS", ["http://localhost:5173", "http://localhost:5174"])
    )


settings = Settings()
