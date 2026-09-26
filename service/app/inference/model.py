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
from pathlib import Path
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


class ScutResearchModel:
    """Local research-only SCUT-FBP5500 runner; never enable for public launch."""
    def __init__(self, manifest: Manifest, model_dir: Path) -> None:
        import timm
        import torch
        if not manifest.weights_file:
            raise RuntimeError("Non-mock model manifest requires weights_file.")
        weight_path = model_dir / manifest.weights_file
        if not weight_path.is_file():
            raise RuntimeError(f"Model weights are missing: {weight_path}")
        self._torch = torch
        self._model = timm.create_model("resnet50", pretrained=False, num_classes=1)
        state = torch.load(weight_path, map_location="cpu", weights_only=True)
        self._model.load_state_dict(state)
        self._model.eval()
        self._width, self._height = manifest.dimensions

    def score(self, buffer: list[float]) -> float:
        tensor = self._torch.tensor(buffer, dtype=self._torch.float32)
        tensor = tensor.reshape(self._height, self._width, 3).permute(2, 0, 1).unsqueeze(0)
        with self._torch.no_grad():
            return float(self._model(tensor).squeeze().item())


def build_runner(manifest: Manifest, model_dir: Path) -> ModelRunner:
    if manifest.is_mock:
        return MockModel(manifest)
    if manifest.license_review == "research-only-scut-fbp5500":
        return ScutResearchModel(manifest, model_dir)
    raise RuntimeError("No approved runner is configured for this non-mock model package.")
