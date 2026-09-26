"""Versioned, deterministic input preprocessing (preprocess-v1).

Steps, applied exactly as the manifest declares:
  1. Decode in memory with a hard pixel-count cap (decompression-bomb defense).
  2. Convert to the manifest color space (RGB).
  3. Resize to the manifest dimensions (the crop/alignment policy for this MVP
     is "client supplies a centered face crop"; the service does not re-detect).
  4. Return a normalized tensor-shaped float buffer.

Determinism matters: golden-image tests pin this pipeline so model/preprocess
drift is caught. The raw bytes and intermediate buffers are never persisted.
"""

from __future__ import annotations

import io

from PIL import Image, UnidentifiedImageError

from ..errors import ServiceError, invalid_image
from .manifest import Manifest

# Belt-and-suspenders against decompression bombs, independent of our own check.
Image.MAX_IMAGE_PIXELS = 8_000_000


def decode(image_bytes: bytes, max_pixels: int) -> Image.Image:
    """Decode with a strict pixel cap. Raises ServiceError(422) on bad input."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        # `.size` is available from the header before full decode.
        width, height = img.size
        if width <= 0 or height <= 0 or width * height > max_pixels:
            raise invalid_image()
        img.load()  # force full decode inside our try
    except ServiceError:
        raise
    except (UnidentifiedImageError, OSError, ValueError):
        raise invalid_image()
    return img


def preprocess(img: Image.Image, manifest: Manifest) -> list[float]:
    """Apply preprocess-v1 and return a flat, normalized float buffer."""
    target_w, target_h = manifest.dimensions
    rgb = img.convert("RGB") if manifest.input.color_space.upper() == "RGB" else img.convert("RGB")
    resized = rgb.resize((target_w, target_h), Image.BILINEAR)
    # Normalize to [0, 1]; the manifest documents the per-channel policy.
    pixels = list(resized.getdata())  # list of (r, g, b)
    out: list[float] = []
    for r, g, b in pixels:
        out.append(r / 255.0)
        out.append(g / 255.0)
        out.append(b / 255.0)
    return out
