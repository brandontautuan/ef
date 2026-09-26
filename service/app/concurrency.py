"""Bounded admission control for inference.

At most `max_concurrency` requests run at once; up to `max_queue` more may wait.
Anything beyond that is shed immediately so load cannot exhaust workers. The
admission count is manipulated only between `await` points, so the event loop's
cooperative scheduling makes the check-and-increment safe without a lock.
"""

from __future__ import annotations

import asyncio


class Admission:
    def __init__(self, max_concurrency: int, max_queue: int) -> None:
        self._sem = asyncio.Semaphore(max_concurrency)
        self._capacity = max_concurrency + max_queue
        self._count = 0

    def try_reserve(self) -> bool:
        """Reserve a slot (running or queued). Returns False if at capacity."""
        if self._count >= self._capacity:
            return False
        self._count += 1
        return True

    def release_reservation(self) -> None:
        self._count -= 1

    async def acquire(self) -> None:
        await self._sem.acquire()

    def release(self) -> None:
        self._sem.release()

    @property
    def in_system(self) -> int:
        return self._count
