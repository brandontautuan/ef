"""Immutable model manifest — the source of truth for preprocessing and range.

Any change to weights, transform, score range, or calibration must ship as a new
`model_version`. The manifest is loaded once at startup and treated as read-only.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class InputSpec:
    color_space: str
    dimensions: tuple[int, int]  # (width, height)
    normalization: str
    alignment: str


@dataclass(frozen=True)
class Manifest:
    model_version: str
    native_min: float
    native_max: float
    input: InputSpec
    license_review: str
    is_mock: bool

    @property
    def dimensions(self) -> tuple[int, int]:
        return self.input.dimensions

    def in_range(self, value: float) -> bool:
        return self.native_min <= value <= self.native_max


def load_manifest(model_dir: Path) -> Manifest:
    data = yaml.safe_load((model_dir / "manifest.yaml").read_text())
    rng = data["native_score_range"]
    inp = data["input"]
    dims = inp["dimensions"]
    return Manifest(
        model_version=str(data["model_version"]),
        native_min=float(rng[0]),
        native_max=float(rng[1]),
        input=InputSpec(
            color_space=str(inp["color_space"]),
            dimensions=(int(dims[0]), int(dims[1])),
            normalization=str(inp["normalization"]),
            alignment=str(inp["alignment"]),
        ),
        license_review=str(data.get("license_review", "pending")),
        is_mock=bool(data.get("is_mock", False)),
    )
