"""HTTP contracts for the anonymous social system (`/v1/social/...`).

Every mutation resolves the caller from the session cookie; no owner, author,
score, or count is ever accepted from the request body. Fixed paths (`head`,
`state`) are declared before the `{post_id}` routes, and post IDs are
syntax-checked, so they cannot be mistaken for each other.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from ..config import settings
from ..db import now_ms
from ..errors import app_error, bad_request, rate_limited_for
from ..http_utils import check_mutation_origin, parse_limit, read_json_model, request_id
from ..sessions import require_viewer, resolve_viewer
from . import media, repository as repo, service
from .schemas import IDEMPOTENCY_KEY_RE, PublishRequest, StateRequest, VoteRequest, validate_post_id

router = APIRouter(prefix="/v1/social")

PAGE_DEFAULT, PAGE_MAX = 20, 50
DAY_MS = 24 * 3600 * 1000


def _db(request: Request):
    return request.app.state.db


def _viewer_id(request: Request) -> Optional[str]:
    viewer = resolve_viewer(request)
    return viewer.player_id if viewer else None


def _json(request: Request, payload: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse({**payload, "request_id": request_id(request)}, status_code=status_code)


# ---- Feeds -------------------------------------------------------------------

@router.get("/posts")
async def latest(request: Request, cursor: Optional[str] = None, limit: Optional[int] = None) -> JSONResponse:
    page = service.seq_feed(
        _db(request), feed="latest", cursor=cursor, limit=parse_limit(limit, PAGE_DEFAULT, PAGE_MAX),
        viewer_player_id=_viewer_id(request), owner_player_id=None, api_base=settings.public_api_base,
    )
    return _json(request, page)


@router.get("/posts/head")
async def feed_head(request: Request, after_seq: int = 0) -> JSONResponse:
    if after_seq < 0 or after_seq > 2**62:
        raise bad_request("after_seq must be a non-negative integer.")
    return _json(request, service.head(_db(request), after_seq))


@router.post("/posts/state")
async def post_states(request: Request) -> JSONResponse:
    """Read-only batch refresh of counts and the caller's vote state."""
    body = await read_json_model(request, StateRequest)
    ids = [post_id for post_id in body.ids if isinstance(post_id, str)]
    for post_id in ids:
        validate_post_id(post_id)
    return _json(request, {"items": service.states(_db(request), ids, _viewer_id(request))})


@router.get("/me/posts")
async def my_posts(request: Request, cursor: Optional[str] = None, limit: Optional[int] = None) -> JSONResponse:
    viewer = require_viewer(request)
    page = service.seq_feed(
        _db(request), feed="mine", cursor=cursor, limit=parse_limit(limit, PAGE_DEFAULT, PAGE_MAX),
        viewer_player_id=viewer.player_id, owner_player_id=viewer.player_id, api_base=settings.public_api_base,
    )
    return _json(request, page)


@router.get("/me/upmogs")
async def my_upmogs(request: Request, cursor: Optional[str] = None, limit: Optional[int] = None) -> JSONResponse:
    viewer = require_viewer(request)
    page = service.upmog_feed(
        _db(request), cursor=cursor, limit=parse_limit(limit, PAGE_DEFAULT, PAGE_MAX),
        player_id=viewer.player_id, api_base=settings.public_api_base,
    )
    return _json(request, page)


@router.get("/me/shareable-results")
async def my_shareable_results(request: Request, cursor: Optional[str] = None, limit: Optional[int] = None) -> JSONResponse:
    viewer = require_viewer(request)
    page = service.shareable_results(
        _db(request), cursor=cursor, limit=parse_limit(limit, PAGE_DEFAULT, PAGE_MAX), player_id=viewer.player_id,
    )
    return _json(request, page)


# ---- Publishing --------------------------------------------------------------

@router.post("/posts")
async def publish(request: Request) -> JSONResponse:
    check_mutation_origin(request)
    viewer = require_viewer(request)
    key = request.headers.get("idempotency-key", "")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise bad_request("Send an Idempotency-Key header (8-128 URL-safe characters).")
    body = await read_json_model(request, PublishRequest)
    db = _db(request)
    with db.read() as conn:
        # Retries of an already-recorded key are answered without consuming limits.
        is_retry = repo.get_dedup(conn, viewer.player_id, service.PUBLISH_OPERATION, key, now_ms()) is not None
        recent = repo.posts_created_since(conn, viewer.player_id, now_ms() - DAY_MS) if not is_retry else 0
    if not is_retry:
        if recent >= settings.posts_per_day:
            raise rate_limited_for(3600, "You've hit today's posting limit. Try again later.")
        if not request.app.state.post_limiter.allow(viewer.player_id):
            raise rate_limited_for(60, "You're posting too fast. Wait a minute and try again.")
    payload, created = service.publish(
        db, request.app.state.post_media_dir, player_id=viewer.player_id, idempotency_key=key,
        result_id=body.result_id, raw_caption=body.caption, include_photo=body.include_photo,
        api_base=settings.public_api_base, retention_ms=settings.idempotency_retention_s * 1000,
    )
    return _json(request, {"post": payload, "created": created}, status_code=201 if created else 200)


# ---- Single post -------------------------------------------------------------

@router.get("/posts/{post_id}")
async def get_post(request: Request, post_id: str) -> JSONResponse:
    validate_post_id(post_id)
    return _json(request, {"post": service.get_one(_db(request), post_id, _viewer_id(request), settings.public_api_base)})


@router.put("/posts/{post_id}/vote")
async def vote(request: Request, post_id: str) -> JSONResponse:
    check_mutation_origin(request)
    viewer = require_viewer(request)
    validate_post_id(post_id)
    body = await read_json_model(request, VoteRequest)
    if not request.app.state.vote_limiter.allow(viewer.player_id):
        raise rate_limited_for(30, "You're voting too fast. Slow down a little.")
    state = service.set_vote(
        _db(request), post_id=post_id, player_id=viewer.player_id, value=body.value,
        expected_revision=body.expected_vote_revision,
    )
    return _json(request, state)


@router.delete("/posts/{post_id}")
async def delete(request: Request, post_id: str) -> Response:
    check_mutation_origin(request)
    viewer = require_viewer(request)
    validate_post_id(post_id)
    service.delete_post(_db(request), post_id=post_id, player_id=viewer.player_id)
    return Response(status_code=204)


@router.get("/posts/{post_id}/media")
async def post_media(request: Request, post_id: str) -> Response:
    validate_post_id(post_id)
    with _db(request).read() as conn:
        post = repo.get_post(conn, post_id)
        if post is None:
            raise app_error(404, "post_not_found", "That mog does not exist.")
        if post["deleted_at"] is not None:
            raise app_error(410, "post_deleted", "That mog was deleted.")
        found = media.resolve_for_post(conn, request.app.state.post_media_dir, post)
    if found is None:
        raise app_error(404, "media_not_found", "This mog has no photo.")
    path, mime = found
    return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, no-store"})
