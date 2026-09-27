"""Sessions, registered scans, display conversion, and the shared leaderboard."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.display_score import DISPLAY_MAPS, get_display_map, tier_for
from app.main import app
from tests.conftest import BASE_URL, make_image
from tests.helpers import eligible_result, live_scan, player_id_of, publish_to_board, seed_result, start_session


# ---- Sessions ------------------------------------------------------------------

def test_get_session_never_creates_identity(client):
    body = client.get("/v1/session").json()
    assert body["authenticated"] is False
    with client.app.state.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM players").fetchone()[0] == 0


def test_session_cookie_attributes_and_reuse(client):
    first = client.post("/v1/session")
    assert first.status_code == 201
    cookie = first.headers["set-cookie"]
    assert cookie.startswith("__Host-mog_session=")
    lowered = cookie.lower()
    for attribute in ("httponly", "secure", "samesite=lax", "path=/", f"max-age={365 * 24 * 3600}"):
        assert attribute in lowered
    assert "domain=" not in lowered
    assert first.headers["cache-control"] == "private, no-store"
    # The raw token never appears in JSON.
    token = client.cookies.get("__Host-mog_session")
    assert token not in first.text
    again = client.post("/v1/session")
    assert again.status_code == 200 and again.json()["created"] is False
    assert again.json()["viewer"]["key"] == first.json()["viewer"]["key"]
    assert client.get("/v1/session").json()["authenticated"] is True


def test_only_token_hash_is_stored(client):
    start_session(client)
    token = client.cookies.get("__Host-mog_session")
    with client.app.state.db.read() as conn:
        stored = [row[0] for row in conn.execute("SELECT token_hash FROM sessions")]
    assert token not in stored and len(stored) == 1 and len(stored[0]) == 64


def test_mutation_without_session_is_401(client):
    for response in (
        client.post("/v1/scans", json={"capture_mode": "live"}),
        client.post("/v1/leaderboard", json={"result_id": "x", "display_name": "abc"}),
        client.post("/v1/social/posts", json={"result_id": "x"}, headers={"Idempotency-Key": "abcdefgh"}),
        client.put("/v1/social/posts/abcdefgh/vote", json={"value": 1, "expected_vote_revision": 0}),
        client.delete("/v1/social/posts/abcdefgh"),
    ):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "session_required"


def test_cross_site_origin_rejected(client):
    r = client.post("/v1/session", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "invalid_origin"
    r = client.post("/v1/session", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert client.post("/v1/session", headers={"Origin": "https://mog.zo.space"}).status_code == 201


def test_expired_session_is_not_accepted(client):
    start_session(client)
    with client.app.state.db.write() as conn:
        conn.execute("UPDATE sessions SET expires_at = 0")
    assert client.get("/v1/session").json()["authenticated"] is False


def test_rolling_renewal_at_most_daily(client):
    start_session(client)
    assert "set-cookie" not in client.get("/v1/session").headers
    with client.app.state.db.write() as conn:
        conn.execute("UPDATE sessions SET renewed_at = renewed_at - ?", (2 * 24 * 3600 * 1000,))
    renewed = client.get("/v1/session")
    assert renewed.headers["set-cookie"].startswith("__Host-mog_session=")
    assert "set-cookie" not in client.get("/v1/session").headers


# ---- Display conversion --------------------------------------------------------

@pytest.mark.parametrize("version", sorted(DISPLAY_MAPS))
def test_display_map_matches_javascript_round(version):
    display_map = get_display_map(version)

    def js(native):  # Math.round(Math.min(100, Math.max(0, x))) with JS half-up rounding
        span = display_map.native_max - display_map.native_min
        x = ((native - display_map.native_min) / span) * 100 + display_map.score_offset
        return math.floor(min(100, max(0, x)) + 0.5)

    for i in range(0, 5001):
        native = 0.5 + i * 0.001
        assert display_map.score(native) == js(native)
    assert display_map.score(display_map.native_min) == display_map.score_offset
    assert display_map.score(display_map.native_max) == 100


def test_half_way_rounds_up_not_to_even():
    m = get_display_map("linear-1-5-v1")
    assert m.score(1.02) == 1  # 0.5 -> 1 (Python round() would give 0)
    assert m.score(1.1) == 3  # 2.5 -> 3 (round() would give 2)


def test_boosted_display_map_adds_ten_points_and_caps_at_one_hundred():
    m = get_display_map("linear-1-5-plus-10-v1")
    assert m.score(2.32) == 43
    assert m.score(2.76) == 54
    assert m.score(5.0) == 100


def test_tier_boundaries():
    expected = {0: "SUB5", 26: "SUB5", 27: "LTN", 42: "LTN", 43: "MTN", 59: "MTN", 60: "HTN", 73: "HTN",
                74: "CHADLITE", 80: "CHADLITE", 81: "CHAD", 89: "CHAD", 90: "ADAM", 96: "ADAM", 97: "TRUE ADAM",
                100: "TRUE ADAM"}
    for score, tier in expected.items():
        assert tier_for(score) == tier


# ---- Registered scans ----------------------------------------------------------

def test_registered_scan_records_median_result(client):
    start_session(client)
    result = live_scan(client)
    with client.app.state.db.read() as conn:
        row = conn.execute("SELECT * FROM scan_results WHERE id = ?", (result["id"],)).fetchone()
    assert row["score"] == result["score"] and row["frame_count"] == 3 and row["capture_mode"] == "live"
    assert row["tier"] == tier_for(row["score"])


def test_duplicate_frame_sequence_is_not_counted_twice(client):
    start_session(client)
    scan = client.post("/v1/scans", json={"capture_mode": "live"}).json()
    image = make_image((10, 20, 30))
    send = lambda seq: client.post(  # noqa: E731
        f"/v1/scans/{scan['scan_id']}/frames", files={"image": ("a.jpg", image, "image/jpeg")},
        data={"frame_sequence": str(seq)},
    ).json()
    first = send(1)
    again = send(1)
    assert first["accepted_frames"] == again["accepted_frames"] == 1
    assert first["native_score"] == again["native_score"]


def test_upload_scan_needs_one_frame(client):
    start_session(client)
    scan = client.post("/v1/scans", json={"capture_mode": "upload"}).json()
    assert scan["required_frames"] == 1
    body = client.post(
        f"/v1/scans/{scan['scan_id']}/frames", files={"image": ("a.jpg", make_image(), "image/jpeg")},
        data={"frame_sequence": "1"},
    ).json()
    assert body["status"] == "complete" and body["result"]["captureMode"] == "upload"


def test_other_players_scan_is_not_found(client, make_client):
    start_session(client)
    scan = client.post("/v1/scans", json={"capture_mode": "live"}).json()
    other = make_client()
    start_session(other)
    r = other.post(
        f"/v1/scans/{scan['scan_id']}/frames", files={"image": ("a.jpg", make_image(), "image/jpeg")},
        data={"frame_sequence": "1"},
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "scan_not_found"


# ---- Shared leaderboard --------------------------------------------------------

def test_leaderboard_best_score_replacement_and_publications(client):
    start_session(client)
    low = seed_result(client, 50)
    assert publish_to_board(client, low, "Ben").json()["outcome"] == "inserted"
    lower = seed_result(client, 40)
    assert publish_to_board(client, lower, "Ben").json()["outcome"] == "not_higher"
    higher = seed_result(client, 70)
    needs = publish_to_board(client, higher, "Ben")
    assert needs.status_code == 409 and needs.json()["error"]["details"] == {"currentScore": 50, "newScore": 70}
    assert publish_to_board(client, higher, "Ben", confirm=True).json()["outcome"] == "replaced"
    with client.app.state.db.read() as conn:
        published = {row[0] for row in conn.execute("SELECT result_id FROM leaderboard_publications")}
        entries = conn.execute("SELECT result_id, score FROM leaderboard_entries").fetchall()
    assert published == {low, higher}  # the rejected lower result is not eligible
    assert [(e["result_id"], e["score"]) for e in entries] == [(higher, 70)]


def test_leaderboard_competition_ranks_and_ownership(client, make_client):
    players = [client, make_client(), make_client()]
    for index, (c, score) in enumerate(zip(players, (80, 80, 60))):
        start_session(c)
        publish_to_board(c, seed_result(c, score), f"P{index}")
    body = players[2].get("/v1/leaderboard").json()
    assert [(i["rank"], i["score"]) for i in body["items"]] == [(1, 80), (1, 80), (3, 60)]
    assert [i["isMine"] for i in body["items"]] == [False, False, True]
    assert "resultId" not in body["items"][0] and "resultId" in body["items"][2]
    assert body["viewerEntry"]["rank"] == 3


def test_leaderboard_rejects_other_players_result_and_bad_names(client, make_client):
    start_session(client)
    mine = seed_result(client, 50)
    other = make_client()
    start_session(other)
    assert publish_to_board(other, mine, "Thief").status_code == 403
    assert publish_to_board(client, mine, "x").json()["error"]["code"] == "invalid_display_name"


def test_leaderboard_pagination(client, make_client):
    clients = [client] + [make_client() for _ in range(4)]
    for i, c in enumerate(clients):
        start_session(c)
        publish_to_board(c, seed_result(c, 50 + i), f"P{i}")
    page1 = client.get("/v1/leaderboard?limit=2").json()
    page2 = client.get(f"/v1/leaderboard?limit=2&cursor={page1['nextCursor']}").json()
    page3 = client.get(f"/v1/leaderboard?limit=2&cursor={page2['nextCursor']}").json()
    scores = [i["score"] for p in (page1, page2, page3) for i in p["items"]]
    assert scores == [54, 53, 52, 51, 50] and page3["nextCursor"] is None


def test_remove_my_entry_keeps_publication(client):
    start_session(client)
    result_id = eligible_result(client, score=55)
    assert client.delete("/v1/leaderboard/me").status_code == 204
    with client.app.state.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM leaderboard_entries").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM leaderboard_publications WHERE result_id = ?", (result_id,)).fetchone()[0] == 1


def test_data_survives_restart(tmp_path):
    app.state.db_path_override = tmp_path / "restart.sqlite3"
    app.state.post_media_dir_override = tmp_path / "media"
    with TestClient(app, base_url=BASE_URL) as first:
        start_session(first)
        result_id = eligible_result(first, score=61)
        post_id = first.post(
            "/v1/social/posts", json={"result_id": result_id}, headers={"Idempotency-Key": "restart-key-1"}
        ).json()["post"]["id"]
        cookies = dict(first.cookies)
        player = player_id_of(first)
    with TestClient(app, base_url=BASE_URL, cookies=cookies) as second:
        assert second.get("/v1/session").json()["authenticated"] is True
        assert player_id_of(second) == player
        post = second.get(f"/v1/social/posts/{post_id}").json()["post"]
        assert post["isOwner"] is True and post["viewerVote"] == 1 and post["mogScore"] == 1
        assert second.delete(f"/v1/social/posts/{post_id}").status_code == 204
