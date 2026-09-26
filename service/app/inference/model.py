"""Model runners.

Only a mock/staging runner ships until model + dataset rights and validation are
signed off (see the launch gate). The mock produces a deterministic native score
from the preprocessed buffer so the full request lifecycle, contract, and golden
tests can be exercised without any licensed weights.

A real runner implements the same `ModelRunner` interface: consume the
preprocess-v1 buffer, return one finite native score. The service validates the
result against the manifest range regardless of runner.
"""

from __future__ import annotations

import hashlib
import struct
from typing import Protocol

from .manifest import Manifest


class ModelRunner(Protocol):
    def score(self, buffer: list[float]) -> float:
        """Return a native score for one preprocessed image buffer."""
        ...


class MockModel:
    """Deterministic stand-in. NOT an attractiveness estimate of any kind.

    Maps a stable hash of the preprocessed buffer into the manifest's native
    range. Same input -> same output, which is what the golden-image test needs.
    """

    def __init__(self, manifest: Manifest) -> None:
        self._min = manifest.native_min
        self._max = manifest.native_max

    def score(self, buffer: list[float]) -> float:
        # Quantize floats to bytes for a stable, platform-independent digest.
        raw = bytes(int(v * 255) & 0xFF for v in buffer)
        digest = hashlib.sha256(raw).digest()
        # Take 8 bytes -> unsigned int -> unit interval -> native range.
        (chunk,) = struct.unpack(">Q", digest[:8])
        unit = chunk / 0xFFFFFFFFFFFFFFFF
        return self._min + unit * (self._max - self._min)


def build_runner(manifest: Manifest) -> ModelRunner:
    if manifest.is_mock:
        return MockModel(manifest)
    # A real runner would be constructed here from the model package.
    raise RuntimeError(
        "No licensed model runner is configured; only the mock/staging model is "
        "available until the launch gate is cleared."
    )
