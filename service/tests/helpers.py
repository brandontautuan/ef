"""Test helpers. Synthetic images only; no real faces or captures."""

from __future__ import annotations

import hashlib
import itertools
import secrets

from app.db import now_ms
from app.sessions import SECURE_COOKIE_NAME
from tests.conftest import make_image

_colors = itertools.count(1)


def start_session(client) -> dict:
    response = client.post("/v1/session")
    assert response.status_code in (200, 201), response.text
    return response.json()


def player_id_of(client) -> str:
    token = client.cookies.get(SECURE_COOKIE_NAME)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with client.app.state.db.read() as conn:
        return conn.execute("SELECT player_id FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone()["player_id"]


def live_scan(client) -> dict:
    """Run a real registered 3-frame scan through the mock model."""
    scan = client.post("/v1/scans", json={"capture_mode": "live"}).json()
    body = None
    for seq in (1, 2, 3):
        n = next(_colors)
        image = make_image(((n * 37) % 256, (n * 91) % 256, (n * 53) % 256))
        response = client.post(
            f"/v1/scans/{scan['scan_id']}/frames",
            files={"image": ("crop.jpg", image, "image/jpeg")},
            data={"frame_sequence": str(seq)},
        )
        assert response.status_code == 200, response.text
        body = response.json()
    assert body["status"] == "complete"
    return body["result"]


def seed_result(client, score: int, *, match_id: str | None = None, capture_mode: str = "live") -> str:
    """Insert a completed server result with a controlled score for the caller."""
    result_id = secrets.token_urlsafe(12)
    app = client.app
    with app.state.db.write() as conn:
        conn.execute(
            "INSERT INTO scan_results (id, player_id, match_id, capture_mode, score, tier, model_version, "
            "display_map_version, frame_count, created_at) VALUES (?, ?, ?, ?, ?, 'HTN', ?, ?, 3, ?)",
            (result_id, player_id_of(client), match_id, capture_mode, score, app.state.manifest.model_version,
             app.state.display_map.version, now_ms()),
        )
    return result_id


def publish_to_board(client, result_id: str, name: str = "Tester", confirm: bool = False):
    return client.post(
        "/v1/leaderboard", json={"result_id": result_id, "display_name": name, "confirm_replace": confirm}
    )


def eligible_result(client, name: str = "Tester", score: int | None = None) -> str:
    result_id = seed_result(client, score) if score is not None else live_scan(client)["id"]
    response = publish_to_board(client, result_id, name, confirm=True)
    assert response.status_code in (200, 201), response.text
    # Only accepted results (insert or higher-score replacement) become eligible.
    assert response.json()["outcome"] in ("inserted", "replaced"), response.text
    return result_id


def publish_post(client, result_id: str, caption=None, key: str | None = None, **extra):
    body = {"result_id": result_id, **extra}
    if caption is not None:
        body["caption"] = caption
    return client.post(
        "/v1/social/posts", json=body, headers={"Idempotency-Key": key or secrets.token_urlsafe(12)}
    )


def new_post(client, name: str = "Tester", caption=None, score: int | None = None) -> dict:
    response = publish_post(client, eligible_result(client, name, score=score), caption)
    assert response.status_code == 201, response.text
    return response.json()["post"]


def vote(client, post_id: str, value: int, expected: int):
    return client.put(f"/v1/social/posts/{post_id}/vote", json={"value": value, "expected_vote_revision": expected})
