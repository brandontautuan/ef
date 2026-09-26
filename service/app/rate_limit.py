"""In-memory, privacy-preserving rate limiting.

The network key is a salted hash of the client IP. The salt is random per
process and never persisted, so the stored key is not reversible to an IP and
nothing links a scan to a person. This is a single-process limiter suitable for
the MVP; a multi-instance deployment would move this to a shared store while
keeping the same non-reversible keying.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections import deque


class RateLimiter:
    def __init__(self, max_requests: int, window_s: float) -> None:
        self._max = max_requests
        self._window = window_s
        self._salt = os.urandom(16)
        self._hits: dict[str, deque[float]] = {}

    def _key(self, client_ip: str) -> str:
        return hashlib.sha256(self._salt + client_ip.encode("utf-8")).hexdigest()

    def allow(self, client_ip: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        key = self._key(client_ip)
        window_start = now - self._window
        bucket = self._hits.setdefault(key, deque())
        while bucket and bucket[0] < window_start:
            bucket.popleft()
        if len(bucket) >= self._max:
            return False
        bucket.append(now)
        return True

    def sweep(self, now: float | None = None) -> None:
        """Drop empty/stale buckets so memory does not grow unbounded."""
        now = time.monotonic() if now is None else now
        window_start = now - self._window
        for key in list(self._hits.keys()):
            bucket = self._hits[key]
            while bucket and bucket[0] < window_start:
                bucket.popleft()
            if not bucket:
                del self._hits[key]
