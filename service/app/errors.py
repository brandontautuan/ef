"""Stable, non-sensitive error taxonomy for the scoring service.

Error responses always use the shape:
    { "error": { "code": ..., "message": ... }, "request_id": ... }

Messages are deliberately generic: they never leak stack traces, model
internals, image-derived attributes, or identity information.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(eq=False)  # not frozen: exceptions must accept __traceback__ when re-raised
class ServiceError(Exception):
    """A client- or server-facing error mapped to a stable code + HTTP status.

    `details` is optional structured data for conflict reconciliation (for
    example the authoritative vote state after a stale write). `headers` carries
    response headers such as `Retry-After`.
    """

    status_code: int
    code: str
    message: str
    details: Optional[dict[str, Any]] = None
    headers: Optional[dict[str, str]] = None

    def __str__(self) -> str:  # avoid leaking anything beyond the stable code
        return self.code


# 400 — missing/malformed metadata
def bad_request(message: str = "Missing or malformed request fields.") -> ServiceError:
    return ServiceError(400, "bad_request", message)


# 413 — payload too large
def payload_too_large() -> ServiceError:
    return ServiceError(413, "payload_too_large", "The image crop is too large.")


# 415 — unsupported content type
def unsupported_media() -> ServiceError:
    return ServiceError(415, "unsupported_media_type", "Use a supported image crop (JPEG or WebP).")


# 422 — undecodable or unsuitable image content
def invalid_image() -> ServiceError:
    return ServiceError(422, "invalid_image", "Use a supported image crop and try again.")


# 429 — rate limited
def rate_limited() -> ServiceError:
    return ServiceError(429, "rate_limited", "Too many requests. Please slow down and try again.")


# 503 — inference unavailable / overloaded / timed out
def unavailable() -> ServiceError:
    return ServiceError(503, "unavailable", "The scoring service is busy. Please try again.")


# ---- Application (session / leaderboard / social) errors -------------------

def app_error(status_code: int, code: str, message: str, details: Optional[dict[str, Any]] = None) -> ServiceError:
    return ServiceError(status_code, code, message, details)


def session_required() -> ServiceError:
    return ServiceError(401, "session_required", "Start an anonymous session to do that. Check that cookies are allowed.")


def invalid_origin() -> ServiceError:
    return ServiceError(403, "invalid_origin", "This request came from an origin that is not allowed.")


def rate_limited_for(retry_after_s: int, message: str = "Too many requests. Please slow down and try again.") -> ServiceError:
    return ServiceError(429, "rate_limited", message, None, {"Retry-After": str(max(1, int(retry_after_s)))})
