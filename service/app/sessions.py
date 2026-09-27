"""Anonymous cookie sessions shared by scanning, leaderboard, 1v1, and social.

The raw 256-bit token lives only in an HttpOnly cookie; the database stores its
SHA-256 hash. One browser profile keeps one player across every feature. There
is no login, recovery, fingerprinting, or IP-based identity.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .config import settings
from .db import Database, iso, now_ms
from .errors import rate_limited_for, session_required
from .http_utils import check_mutation_origin, network_key, request_id
from .rate_limit import RateLimiter

router = APIRouter()

SECURE_COOKIE_NAME = "__Host-mog_session"
DEV_COOKIE_NAME = "mog_session_dev"
DAY_MS = 24 * 3600 * 1000


def cookie_name() -> str:
    return SECURE_COOKIE_NAME if settings.session_cookie_secure else DEV_COOKIE_NAME


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def viewer_key(player_id: str) -> str:
    """A stable, non-secret label tabs use to notice an identity change."""
    return hashlib.sha256(f"viewer:{player_id}".encode()).hexdigest()[:20]


@dataclass(frozen=True)
class Viewer:
    player_id: str
    display_name: Optional[str]
    expires_at: int


def _max_age_s() -> int:
    return settings.session_ttl_days * 24 * 3600


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        cookie_name(),
        token,
        max_age=_max_age_s(),
        path="/",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )


def _db(request: Request) -> Database:
    return request.app.state.db


def resolve_viewer(request: Request) -> Optional[Viewer]:
    """Resolve the cookie to a player, renewing it at most once per day."""
    cached = getattr(request.state, "viewer_resolved", False)
    if cached:
        return request.state.viewer
    token = request.cookies.get(cookie_name())
    viewer: Optional[Viewer] = None
    if token and 20 <= len(token) <= 128:
        token_hash = hash_token(token)
        now = now_ms()
        db = _db(request)
        with db.read() as conn:
            row = conn.execute(
                "SELECT s.player_id, s.expires_at, s.renewed_at, p.display_name FROM sessions s "
                "JOIN players p ON p.id = s.player_id WHERE s.token_hash = ? AND s.expires_at > ?",
                (token_hash, now),
            ).fetchone()
        if row:
            expires_at = row["expires_at"]
            if now - row["renewed_at"] >= settings.session_renew_after_s * 1000:
                expires_at = now + settings.session_ttl_days * DAY_MS
                with db.write() as conn:
                    conn.execute(
                        "UPDATE sessions SET renewed_at = ?, expires_at = ? WHERE token_hash = ?",
                        (now, expires_at, token_hash),
                    )
                request.state.renew_cookie_token = token
            viewer = Viewer(row["player_id"], row["display_name"], expires_at)
    request.state.viewer_resolved = True
    request.state.viewer = viewer
    return viewer


def require_viewer(request: Request) -> Viewer:
    viewer = resolve_viewer(request)
    if viewer is None:
        raise session_required()
    return viewer


def _viewer_payload(viewer: Viewer) -> dict:
    return {
        "authenticated": True,
        "viewer": {"key": viewer_key(viewer.player_id), "displayName": viewer.display_name},
        "sessionExpiresAt": iso(viewer.expires_at),
    }


def _limiter(request: Request) -> RateLimiter:
    return request.app.state.session_create_limiter


@router.post("/v1/session")
async def create_session(request: Request) -> JSONResponse:
    rid = request_id(request)
    check_mutation_origin(request)
    existing = resolve_viewer(request)
    if existing is not None:
        return JSONResponse({**_viewer_payload(existing), "created": False, "request_id": rid})
    if not _limiter(request).allow(network_key(request)):
        raise rate_limited_for(600, "Too many new sessions from this network. Try again later.")
    token = secrets.token_urlsafe(32)  # 256 bits
    player_id = uuid.uuid4().hex
    now = now_ms()
    expires_at = now + settings.session_ttl_days * DAY_MS
    with _db(request).write() as conn:
        conn.execute(
            "INSERT INTO players (id, display_name, created_at, updated_at) VALUES (?, NULL, ?, ?)",
            (player_id, now, now),
        )
        conn.execute(
            "INSERT INTO sessions (token_hash, player_id, created_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (hash_token(token), player_id, now, now, expires_at),
        )
    viewer = Viewer(player_id, None, expires_at)
    response = JSONResponse({**_viewer_payload(viewer), "created": True, "request_id": rid}, status_code=201)
    set_session_cookie(response, token)
    return response


@router.get("/v1/session")
async def get_session(request: Request) -> JSONResponse:
    """Confirm a persisted cookie. Never creates an identity as a side effect."""
    rid = request_id(request)
    viewer = resolve_viewer(request)
    if viewer is None:
        return JSONResponse({"authenticated": False, "viewer": None, "request_id": rid})
    return JSONResponse({**_viewer_payload(viewer), "request_id": rid})
