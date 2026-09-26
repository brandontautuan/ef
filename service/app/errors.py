"""Stable, non-sensitive error taxonomy for the scoring service.

Error responses always use the shape:
    { "error": { "code": ..., "message": ... }, "request_id": ... }

Messages are deliberately generic: they never leak stack traces, model
internals, image-derived attributes, or identity information.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ServiceError(Exception):
    """A client- or server-facing error mapped to a stable code + HTTP status."""

    status_code: int
    code: str
    message: str

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
