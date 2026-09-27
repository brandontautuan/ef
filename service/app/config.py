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

    # ---- Shared application data (sessions, results, leaderboard, social) ----
    # SQLite database for durable application data. Runtime data is git-ignored.
    database_path: Path = field(
        default_factory=lambda: Path(
            os.environ.get("DATABASE_PATH", str(_SERVICE_ROOT / "data" / "mog.sqlite3"))
        )
    )
    # Independent storage for published post photos (served only while active).
    post_media_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("POST_MEDIA_DIR", str(_SERVICE_ROOT / "data" / "post-media"))
        )
    )
    # Display conversion used for server-recorded results (see display_score.py).
    # Use the active model package's declared 1–5 native range plus the small
    # display offset used by the client. The legacy 2.4–4.0 heuristic floors
    # any score at or below 2.4 to zero.
    display_map: str = field(default_factory=lambda: os.environ.get("DISPLAY_MAP", "linear-1-5-plus-10-v1"))

    # Anonymous cookie session. Secure (`__Host-mog_session`) by default; set
    # SESSION_COOKIE_SECURE=0 only for explicit plain-HTTP localhost development,
    # which switches to the separately named `mog_session_dev` cookie.
    session_cookie_secure: bool = field(default_factory=lambda: _bool("SESSION_COOKIE_SECURE", True))
    session_ttl_days: int = field(default_factory=lambda: _int("SESSION_TTL_DAYS", 365))
    session_renew_after_s: int = field(default_factory=lambda: _int("SESSION_RENEW_AFTER_S", 24 * 3600))

    # Exact origins allowed to send state-changing requests. Requests without an
    # Origin header are accepted only when the browser marks them same-origin.
    mutation_origins: list[str] = field(
        default_factory=lambda: _origins(
            "MUTATION_ORIGINS",
            ["https://mog.zo.space", "http://localhost:5173", "http://localhost:5174"],
        )
    )
    # Header set by the hosting proxy that carries the real client address. Leave
    # empty unless that proxy overwrites it; arbitrary forwarded headers are
    # client-controlled and must not be trusted.
    trusted_client_ip_header: str = field(default_factory=lambda: os.environ.get("TRUSTED_CLIENT_IP_HEADER", "").lower())

    # Registered scans (in-memory, expiring; never persisted with image data).
    scan_session_ttl_s: int = field(default_factory=lambda: _int("SCAN_SESSION_TTL_S", 600))
    max_frames_per_scan: int = field(default_factory=lambda: _int("MAX_FRAMES_PER_SCAN", 24))

    # Social limits (spec section 14).
    session_create_per_hour: int = field(default_factory=lambda: _int("SESSION_CREATE_PER_HOUR", 30))
    posts_per_minute: int = field(default_factory=lambda: _int("POSTS_PER_MINUTE", 5))
    posts_per_day: int = field(default_factory=lambda: _int("POSTS_PER_DAY", 30))
    votes_per_minute: int = field(default_factory=lambda: _int("VOTES_PER_MINUTE", 60))
    social_max_body_bytes: int = field(default_factory=lambda: _int("SOCIAL_MAX_BODY_BYTES", 8 * 1024))
    idempotency_retention_s: int = field(default_factory=lambda: _int("IDEMPOTENCY_RETENTION_S", 48 * 3600))
    # Public same-origin prefix the hosting proxy maps to this service's /v1
    # routes; used only to build same-origin media URLs in responses.
    public_api_base: str = field(default_factory=lambda: os.environ.get("PUBLIC_API_BASE", "/api/mog").rstrip("/"))
    maintenance_interval_s: float = field(default_factory=lambda: _float("MAINTENANCE_INTERVAL_S", 300.0))


_SERVICE_ROOT = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


settings = Settings()
