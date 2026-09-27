"""Strict request validation for social mutations; unknown fields are rejected."""

from __future__ import annotations

import re
import unicodedata
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..errors import app_error

CAPTION_MAX_CODE_POINTS = 280
POST_ID_PATTERN = r"^[A-Za-z0-9_-]{8,32}$"
POST_ID_RE = re.compile(POST_ID_PATTERN)
IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,128}$")


class PublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    result_id: str = Field(min_length=1, max_length=64)
    caption: Optional[str] = Field(default=None, max_length=4096)
    include_photo: bool = False


class VoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    value: int
    expected_vote_revision: int = Field(ge=0, le=2**62)

    @field_validator("value")
    @classmethod
    def _value(cls, v: int) -> int:
        if v not in (-1, 0, 1):
            raise ValueError("value must be -1, 0, or 1")
        return v


class StateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ids: list[str] = Field(max_length=50)


def normalize_caption(raw: Optional[str]) -> Optional[str]:
    """Trim, normalize line endings, reject control characters, enforce length.

    Length counts Unicode code points, matching the client's `[...text].length`.
    Stored and rendered as plain text; never HTML or Markdown.
    """
    if raw is None:
        return None
    text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return None
    for ch in text:
        if ch == "\n":
            continue
        category = unicodedata.category(ch)
        if category in ("Cc", "Cs"):
            raise app_error(400, "invalid_caption", "Captions can't contain control characters.")
    if len(text) > CAPTION_MAX_CODE_POINTS:
        raise app_error(400, "invalid_caption", f"Captions are limited to {CAPTION_MAX_CODE_POINTS} characters.")
    return text


def validate_post_id(post_id: str) -> str:
    if not POST_ID_RE.match(post_id):
        raise app_error(404, "post_not_found", "That mog does not exist.")
    return post_id
