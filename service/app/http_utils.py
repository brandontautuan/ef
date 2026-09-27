"""Small request helpers shared by the session, leaderboard, and social routes."""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Type, TypeVar

from fastapi import Request
from pydantic import BaseModel, ValidationError

from .config import settings
from .errors import ServiceError, bad_request, invalid_origin

M = TypeVar("M", bound=BaseModel)


def new_request_id() -> str:
    return os.urandom(12).hex()


def request_id(request: Request) -> str:
    rid = getattr(request.state, "request_id", None)
    if not rid:
        rid = new_request_id()
        request.state.request_id = rid
    return rid


def network_key(request: Request) -> str:
    """A coarse network key for secondary rate limits. Never an identity.

    Only a header named in TRUSTED_CLIENT_IP_HEADER (one the hosting proxy
    overwrites) is used; otherwise the socket peer address.
    """
    header = settings.trusted_client_ip_header
    if header:
        value = request.headers.get(header, "").split(",")[0].strip()
        if value:
            return value
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def check_mutation_origin(request: Request) -> None:
    """Reject cross-site state changes. This is not authentication."""
    origin = request.headers.get("origin")
    if origin is not None:
        if origin not in settings.mutation_origins:
            raise invalid_origin()
        return
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        raise invalid_origin()


async def read_json_model(request: Request, model: Type[M], max_bytes: int | None = None) -> M:
    """Read a bounded JSON body and validate it strictly (unknown fields rejected)."""
    limit = max_bytes or settings.social_max_body_bytes
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                raise ServiceError(413, "payload_too_large", "The request body is too large.")
        except ValueError:
            raise bad_request()
    body = await request.body()
    if len(body) > limit:
        raise ServiceError(413, "payload_too_large", "The request body is too large.")
    content_type = request.headers.get("content-type", "")
    if body and not content_type.split(";")[0].strip().lower() == "application/json":
        raise ServiceError(415, "unsupported_media_type", "Send JSON with Content-Type: application/json.")
    try:
        return model.model_validate_json(body or b"{}")
    except ValidationError:
        raise bad_request("Invalid request fields.")


def encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def decode_cursor(cursor: str, max_len: int = 256) -> dict[str, Any]:
    if not cursor or len(cursor) > max_len:
        raise ServiceError(400, "invalid_cursor", "That page cursor is not valid.")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except Exception:
        raise ServiceError(400, "invalid_cursor", "That page cursor is not valid.")
    if not isinstance(data, dict):
        raise ServiceError(400, "invalid_cursor", "That page cursor is not valid.")
    return data


def cursor_int(data: dict[str, Any], key: str, minimum: int = 0, maximum: int = 2**62) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or not (minimum <= value <= maximum):
        raise ServiceError(400, "invalid_cursor", "That page cursor is not valid.")
    return value


def parse_limit(raw: int | None, default: int, maximum: int) -> int:
    if raw is None:
        return default
    if raw < 1 or raw > maximum:
        raise bad_request(f"limit must be between 1 and {maximum}.")
    return raw
