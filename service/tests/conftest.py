import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

BASE_URL = "https://testserver"  # HTTPS so the Secure __Host- session cookie round-trips


@pytest.fixture
def client(tmp_path):
    # Every test gets its own database and post-media directory.
    app.state.db_path_override = tmp_path / "mog.sqlite3"
    app.state.post_media_dir_override = tmp_path / "post-media"
    with TestClient(app, base_url=BASE_URL) as c:
        yield c


@pytest.fixture
def make_client(client):
    """Additional independent browser identities sharing the same app/database."""

    def _make() -> TestClient:
        return TestClient(app, base_url=BASE_URL)

    return _make


def make_image(color=(120, 90, 200), size=(256, 256), fmt="JPEG") -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


@pytest.fixture
def jpeg_bytes():
    return make_image()
