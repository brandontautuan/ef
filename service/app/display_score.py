"""Server-side display conversion and tiers for recorded results.

The browser's conversion is `Math.round(clamp(((native - min) / span) * 100))`.
JavaScript's `Math.round` rounds halves up, while Python's `round()` rounds
halves to even, so the explicit `floor(x + 0.5)` form is used here. The
operation order matches the client so both produce identical doubles.

Each map carries its own version string so results produced with different
conversions are never ranked or compared together.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class DisplayMap:
    version: str
    native_min: float
    native_max: float

    def score(self, native: float) -> int:
        span = self.native_max - self.native_min
        value = ((native - self.native_min) / span) * 100
        return int(min(100, max(0, math.floor(value + 0.5))))


DISPLAY_MAPS: dict[str, DisplayMap] = {
    # Matches this repository's client (DISPLAY_NATIVE_MIN/MAX in src/main.tsx).
    "heuristic-2.4-4.0-v1": DisplayMap("heuristic-2.4-4.0-v1", 2.4, 4.0),
    # The deployed site's native 1-5 linear map described in the 1v1 plan.
    "linear-1-5-v1": DisplayMap("linear-1-5-v1", 1.0, 5.0),
}

# Existing tier thresholds; unchanged by the shared/social work.
TIER_THRESHOLDS: tuple[tuple[int, str], ...] = (
    (97, "TRUE ADAM"),
    (90, "ADAM"),
    (81, "CHAD"),
    (74, "CHADLITE"),
    (60, "HTN"),
    (43, "MTN"),
    (27, "LTN"),
)


def tier_for(score: int) -> str:
    for threshold, label in TIER_THRESHOLDS:
        if score >= threshold:
            return label
    return "SUB5"


def get_display_map(version: str) -> DisplayMap:
    try:
        return DISPLAY_MAPS[version]
    except KeyError as exc:
        raise RuntimeError(f"Unknown DISPLAY_MAP {version!r}; expected one of {sorted(DISPLAY_MAPS)}") from exc


def median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]
