"""Anonymous social system: publish, vote, delete, feeds, and retries (spec §15)."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.db import now_ms
from app.social import repository, service
from app.social.repository import reconcile_counts
from tests.helpers import (
    eligible_result,
    new_post,
    player_id_of,
    publish_post,
    publish_to_board,
    seed_result,
    start_session,
    vote,
)


def _counts(client, post_id):
    with client.app.state.db.read() as conn:
        post = conn.execute("SELECT up_count, down_count, mog_score FROM social_posts WHERE id = ?", (post_id,)).fetchone()
    return post["up_count"], post["down_count"], post["mog_score"]


def _vote_rows(client, post_id):
    with client.app.state.db.read() as conn:
        return conn.execute("SELECT player_id, value, revision FROM social_votes WHERE post_id = ?", (post_id,)).fetchall()


@pytest.fixture
def author(client):
    start_session(client)
    return client


@pytest.fixture
def voter(make_client):
    c = make_client()
    start_session(c)
    return c


# ---- Publishing ----------------------------------------------------------------

def test_fresh_publish_creates_one_post_and_author_vote(author):
    post = new_post(author, name="Ben", caption="first")
    assert (post["mogScore"], post["upCount"], post["downCount"]) == (1, 1, 0)
    assert post["viewerVote"] == 1 and post["viewerVoteRevision"] == 1 and post["isOwner"] is True
    assert post["authorLabel"] == "Ben" and post["caption"] == "first"
    rows = _vote_rows(author, post["id"])
    assert len(rows) == 1 and rows[0]["value"] == 1 and rows[0]["player_id"] == player_id_of(author)
    with author.app.state.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM social_posts").fetchone()[0] == 1


def test_public_representation_hides_internal_ids(author):
    post = new_post(author)
    text = str(post)
    assert player_id_of(author) not in text
    assert set(post) == {
        "id", "feedSeq", "createdAt", "authorLabel", "caption", "result", "mediaUrl", "mogScore", "upCount",
        "downCount", "postRevision", "viewerVote", "viewerVoteRevision", "isOwner",
    }


def test_self_vote_failure_rolls_back_post(author, monkeypatch):
    result_id = eligible_result(author, score=60)

    def boom(*args, **kwargs):
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(repository, "insert_vote", boom)
    with pytest.raises(RuntimeError):  # TestClient re-raises; production returns a 503 envelope
        publish_post(author, result_id)
    with author.app.state.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM social_posts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM request_deduplication").fetchone()[0] == 0


def test_publish_retry_semantics(author):
    result_id = eligible_result(author, score=60)
    first = publish_post(author, result_id, "cap", key="retry-key-0001")
    retry = publish_post(author, result_id, "cap", key="retry-key-0001")
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.json()["post"]["id"] == first.json()["post"]["id"]
    assert len(_vote_rows(author, first.json()["post"]["id"])) == 1
    mismatch = publish_post(author, result_id, "different", key="retry-key-0001")
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"
    duplicate = publish_post(author, result_id, "cap", key="retry-key-0002")
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "result_already_posted"
    assert duplicate.json()["error"]["details"]["postId"] == first.json()["post"]["id"]


def test_publish_requires_idempotency_key(author):
    result_id = eligible_result(author, score=60)
    r = author.post("/v1/social/posts", json={"result_id": result_id})
    assert r.status_code == 400


@pytest.mark.parametrize(
    "extra",
    [{"score": 100}, {"owner_player_id": "x"}, {"mog_score": 99}, {"author": "Someone"}, {"tier": "TRUE ADAM"}],
)
def test_browser_supplied_authority_fields_rejected(author, extra):
    result_id = eligible_result(author, score=30)
    r = publish_post(author, result_id, **extra)
    assert r.status_code == 400


def test_vote_body_rejects_totals_and_player_ids(author):
    post = new_post(author)
    for body in (
        {"value": 1, "expected_vote_revision": 1, "mog_score": 50},
        {"value": 1, "expected_vote_revision": 1, "player_id": "x"},
        {"value": 2, "expected_vote_revision": 0},
        {"value": True, "expected_vote_revision": 0},
        {"value": "1", "expected_vote_revision": 0},
    ):
        assert author.put(f"/v1/social/posts/{post['id']}/vote", json=body).status_code == 400


def test_unpublished_or_foreign_results_cannot_be_posted(author, voter):
    unpublished = seed_result(author, 70)
    r = publish_post(author, unpublished)
    assert r.status_code == 409 and r.json()["error"]["code"] == "result_not_published"
    theirs = eligible_result(voter, "Ben", score=70)
    publish_to_board(author, seed_result(author, 10), "Ben")  # same display name, different cookie
    r = publish_post(author, theirs)
    assert r.status_code == 403 and r.json()["error"]["code"] == "result_not_owned"
    assert publish_post(author, "does-not-exist").status_code == 404


def test_rejected_lower_score_is_not_eligible(author):
    eligible_result(author, score=70)
    lower = seed_result(author, 50)
    assert publish_to_board(author, lower, "Tester").json()["outcome"] == "not_higher"
    assert publish_post(author, lower).json()["error"]["code"] == "result_not_published"


def test_sealed_match_result_cannot_publish(author):
    result_id = seed_result(author, 80, match_id="match-1")
    with author.app.state.db.write() as conn:  # e.g. a publication recorded ahead of reveal
        conn.execute(
            "INSERT INTO leaderboard_publications VALUES (?, ?, 'Ben', ?)", (result_id, player_id_of(author), now_ms())
        )
    r = publish_post(author, result_id)
    assert r.status_code == 409 and r.json()["error"]["code"] == "match_not_revealed"


def test_photo_request_without_retained_source_media(author):
    result_id = eligible_result(author, score=60)
    r = publish_post(author, result_id, include_photo=True)
    assert r.status_code == 410 and r.json()["error"]["code"] == "source_media_expired"
    assert publish_post(author, result_id, include_photo=False).status_code == 201


def test_new_best_does_not_mutate_older_post_and_old_result_stays_shareable(author):
    old = eligible_result(author, "Ben", score=50)
    new_best = seed_result(author, 90)
    assert publish_to_board(author, new_best, "Benjamin", confirm=True).json()["outcome"] == "replaced"
    # The replaced result remains eligible through its publication record.
    post = publish_post(author, old).json()["post"]
    assert post["result"]["score"] == 50 and post["authorLabel"] == "Ben"
    third = seed_result(author, 95)
    publish_to_board(author, third, "Someone Else", confirm=True)
    assert author.get(f"/v1/social/posts/{post['id']}").json()["post"]["result"]["score"] == 50
    listed = author.get("/v1/social/me/shareable-results").json()["items"]
    assert {i["resultId"]: i["postStatus"] for i in listed} == {third: None, new_best: None, old: "active"}


def test_leaderboard_removal_keeps_post(author):
    post = new_post(author)
    author.delete("/v1/leaderboard/me")
    assert author.get(f"/v1/social/posts/{post['id']}").status_code == 200


# ---- Caption rules -------------------------------------------------------------

def test_caption_unicode_code_point_limit_and_normalization(author, monkeypatch):
    monkeypatch.setattr(author.app.state.post_limiter, "_max", 100)
    emoji = "😀"  # one code point, two UTF-16 units
    ok = publish_post(author, eligible_result(author, score=10), emoji * 280)
    assert ok.status_code == 201 and len(ok.json()["post"]["caption"]) == 280
    too_long = publish_post(author, eligible_result(author, score=20), emoji * 281)
    assert too_long.status_code == 400 and too_long.json()["error"]["code"] == "invalid_caption"
    trimmed = publish_post(author, eligible_result(author, score=30), "  " + "a" * 280 + "\n ")
    assert trimmed.status_code == 201
    crlf = publish_post(author, eligible_result(author, score=40), "line1\r\nline2\rline3")
    assert crlf.json()["post"]["caption"] == "line1\nline2\nline3"
    control = publish_post(author, eligible_result(author, score=50), "bad\x07bell")
    assert control.status_code == 400
    html = publish_post(author, eligible_result(author, score=60), "<b>plain</b>")
    assert html.json()["post"]["caption"] == "<b>plain</b>"  # stored as text; the client renders text
    blank = publish_post(author, eligible_result(author, score=70), "   ")
    assert blank.json()["post"]["caption"] is None


# ---- Voting --------------------------------------------------------------------

TRANSITIONS = [
    (0, 1, 1, +1),
    (1, 1, 0, -1),
    (-1, 1, 1, +2),
    (0, -1, -1, -1),
    (-1, -1, 0, +1),
    (1, -1, -1, -2),
]


@pytest.mark.parametrize("existing, clicked, desired, delta", TRANSITIONS)
def test_vote_transition_table(author, voter, existing, clicked, desired, delta):
    post = new_post(author)
    revision = 0
    if existing:
        revision = vote(voter, post["id"], existing, 0).json()["viewerVoteRevision"]
    before = _counts(author, post["id"])[2]
    # Client-side rule: clicking the selected button clears it; otherwise select it.
    computed = 0 if clicked == existing else clicked
    assert computed == desired
    response = vote(voter, post["id"], desired, revision)
    assert response.status_code == 200
    body = response.json()
    assert body["viewerVote"] == desired
    assert body["mogScore"] - before == delta
    assert body["mogScore"] == body["upCount"] - body["downCount"]


def test_spec_example_sequence(author, make_client):
    post = new_post(author)
    second, third = make_client(), make_client()
    start_session(second)
    start_session(third)
    assert vote(second, post["id"], 1, 0).json()["mogScore"] == 2
    assert vote(third, post["id"], -1, 0).json()["mogScore"] == 1
    assert vote(second, post["id"], -1, 1).json()["mogScore"] == -1
    assert vote(third, post["id"], 0, 1).json()["mogScore"] == 0


def test_repeating_desired_value_is_noop(author, voter):
    post = new_post(author)
    first = vote(voter, post["id"], 1, 0).json()
    again = vote(voter, post["id"], 1, 0).json()  # lost-response retry with the original revision
    assert again == {**first, "request_id": again["request_id"]}
    assert again["postRevision"] == first["postRevision"] and again["viewerVoteRevision"] == 1


def test_removed_vote_keeps_row_and_leaves_upmogs(author, voter):
    post = new_post(author)
    vote(voter, post["id"], 1, 0)
    assert [p["id"] for p in voter.get("/v1/social/me/upmogs").json()["items"]] == [post["id"]]
    removed = vote(voter, post["id"], 0, 1).json()
    assert removed["viewerVote"] == 0 and removed["viewerVoteRevision"] == 2
    rows = {r["player_id"]: r for r in _vote_rows(author, post["id"])}
    assert rows[player_id_of(voter)]["value"] == 0 and rows[player_id_of(voter)]["revision"] == 2
    assert voter.get("/v1/social/me/upmogs").json()["items"] == []


def test_author_vote_uses_same_rules(author):
    post = new_post(author)
    removed = vote(author, post["id"], 0, 1).json()
    assert removed["mogScore"] == 0 and removed["viewerVote"] == 0
    down = vote(author, post["id"], -1, 2).json()
    assert down["mogScore"] == -1  # net count may go negative; never clamped
    assert author.get("/v1/social/me/upmogs").json()["items"] == []


def test_stale_vote_revision_conflicts_with_latest_state(author, make_client):
    post = new_post(author)
    tab = make_client()
    start_session(tab)
    vote(tab, post["id"], 1, 0)  # revision 1 in "tab A"
    vote(tab, post["id"], -1, 1)  # revision 2 in "tab B"
    stale = vote(tab, post["id"], 0, 1)  # tab A still thinks revision 1
    assert stale.status_code == 409
    details = stale.json()["error"]["details"]
    assert details["viewerVote"] == -1 and details["viewerVoteRevision"] == 2
    assert _counts(author, post["id"]) == (1, 1, 0)


def test_concurrent_unique_voters_do_not_lose_increments(author):
    post = new_post(author)
    db = author.app.state.db
    now = now_ms()
    players = [f"p{i:03d}" for i in range(40)]
    with db.write() as conn:
        conn.executemany("INSERT INTO players (id, created_at, updated_at) VALUES (?, ?, ?)", [(p, now, now) for p in players])
    barrier = threading.Barrier(len(players))

    def cast(index_player):
        index, player = index_player
        barrier.wait()
        value = 1 if index % 4 else -1
        return service.set_vote(db, post_id=post["id"], player_id=player, value=value, expected_revision=0)

    with ThreadPoolExecutor(max_workers=len(players)) as pool:
        list(pool.map(cast, enumerate(players)))
    up = 1 + sum(1 for i in range(40) if i % 4)
    down = sum(1 for i in range(40) if not i % 4)
    assert _counts(author, post["id"]) == (up, down, up - down)
    with db.write() as conn:
        assert reconcile_counts(conn) == []


def test_vote_rate_limit(author, voter, monkeypatch):
    post = new_post(author)
    monkeypatch.setattr(voter.app.state.vote_limiter, "_max", 3)
    revision = 0
    for value in (1, 0, 1):
        revision = vote(voter, post["id"], value, revision).json()["viewerVoteRevision"]
    limited = vote(voter, post["id"], 0, revision)
    assert limited.status_code == 429 and "retry-after" in limited.headers


def test_post_rate_limit_per_minute(author):
    for score in range(10, 15):
        assert publish_post(author, eligible_result(author, score=score)).status_code == 201
    limited = publish_post(author, eligible_result(author, score=20))
    assert limited.status_code == 429 and limited.headers["retry-after"] == "60"


# ---- Deletion ------------------------------------------------------------------

def test_delete_is_owner_only_and_idempotent(author, voter):
    post = new_post(author, name="Ben")
    publish_to_board(voter, seed_result(voter, 5), "Ben")  # identical display name
    denied = voter.delete(f"/v1/social/posts/{post['id']}")
    assert denied.status_code == 403
    vote(voter, post["id"], 1, 0)
    assert author.delete(f"/v1/social/posts/{post['id']}").status_code == 204
    assert author.delete(f"/v1/social/posts/{post['id']}").status_code == 204
    assert voter.delete(f"/v1/social/posts/{post['id']}").status_code == 403
    assert _vote_rows(author, post["id"]) == []
    with author.app.state.db.read() as conn:
        row = conn.execute("SELECT * FROM social_posts WHERE id = ?", (post["id"],)).fetchone()
    assert row["deleted_at"] and row["caption"] is None and row["author_label"] is None and row["scan_score"] is None
    assert (row["up_count"], row["down_count"], row["mog_score"]) == (0, 0, 0)
    gone = voter.get(f"/v1/social/posts/{post['id']}")
    assert gone.status_code == 410 and gone.json()["error"]["code"] == "post_deleted"
    assert voter.get(f"/v1/social/posts/{post['id']}/media").status_code == 410
    assert voter.get("/v1/social/posts/unknown-post-id/media").status_code == 404
    assert author.get("/v1/social/posts").json()["items"] == []


def test_vote_after_delete_cannot_resurrect(author, voter):
    post = new_post(author)
    author.delete(f"/v1/social/posts/{post['id']}")
    late = vote(voter, post["id"], 1, 0)
    assert late.status_code == 410
    assert _counts(author, post["id"]) == (0, 0, 0)
    assert _vote_rows(author, post["id"]) == []


def test_delete_vote_race(author, make_client):
    post = new_post(author)
    db = author.app.state.db
    now = now_ms()
    voters = [f"r{i}" for i in range(20)]
    with db.write() as conn:
        conn.executemany("INSERT INTO players (id, created_at, updated_at) VALUES (?, ?, ?)", [(p, now, now) for p in voters])
    owner = player_id_of(author)
    barrier = threading.Barrier(len(voters) + 1)

    def cast(player):
        barrier.wait()
        try:
            service.set_vote(db, post_id=post["id"], player_id=player, value=1, expected_revision=0)
        except Exception as exc:  # 410 after the tombstone
            assert getattr(exc, "code", None) == "post_deleted"

    def remove():
        barrier.wait()
        service.delete_post(db, post_id=post["id"], player_id=owner)

    with ThreadPoolExecutor(max_workers=len(voters) + 1) as pool:
        futures = [pool.submit(cast, p) for p in voters] + [pool.submit(remove)]
        for future in futures:
            future.result()
    assert _counts(author, post["id"]) == (0, 0, 0)
    assert _vote_rows(author, post["id"]) == []


def test_deleted_result_cannot_be_reposted(author):
    result_id = eligible_result(author, score=60)
    post = publish_post(author, result_id).json()["post"]
    author.delete(f"/v1/social/posts/{post['id']}")
    again = publish_post(author, result_id)
    assert again.status_code == 410 and again.json()["error"]["code"] == "result_post_deleted"
    assert author.get("/v1/social/me/shareable-results").json()["items"][0]["postStatus"] == "deleted"


# ---- Feeds ---------------------------------------------------------------------

def test_latest_pagination_is_stable_when_new_posts_arrive(author, make_client):
    posters = [author] + [make_client() for _ in range(6)]
    for c in posters[1:]:
        start_session(c)
    created = [new_post(c, name=f"P{i}")["id"] for i, c in enumerate(posters[:5])]
    page1 = author.get("/v1/social/posts?limit=2").json()
    new_post(posters[5])  # arrives between requests
    page2 = author.get(f"/v1/social/posts?limit=2&cursor={page1['nextCursor']}").json()
    page3 = author.get(f"/v1/social/posts?limit=2&cursor={page2['nextCursor']}").json()
    seen = [p["id"] for page in (page1, page2, page3) for p in page["items"]]
    assert seen == list(reversed(created)) and page3["nextCursor"] is None
    assert page2["snapshotMaxSeq"] == page1["snapshotMaxSeq"]
    head = author.get(f"/v1/social/posts/head?after_seq={page1['snapshotMaxSeq']}").json()
    assert head["newCount"] == 1 and head["headSeq"] > page1["snapshotMaxSeq"]


def test_feed_limits_and_cursor_validation(author):
    assert author.get("/v1/social/posts?limit=51").status_code == 400
    assert author.get("/v1/social/posts?limit=0").status_code == 400
    bad = author.get("/v1/social/posts?cursor=not-a-cursor")
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_cursor"
    mine = author.get("/v1/social/me/posts").json()
    wrong_feed = author.get(f"/v1/social/posts?cursor={mine['nextCursor'] or 'eyJ2IjoxLCJmIjoibWluZSIsInMiOjEsImIiOjJ9'}")
    assert wrong_feed.status_code == 400


def test_viewer_fields_are_personal(author, voter, make_client):
    post = new_post(author)
    vote(voter, post["id"], -1, 0)
    anonymous = make_client()
    as_author = author.get("/v1/social/posts").json()["items"][0]
    as_voter = voter.get("/v1/social/posts").json()["items"][0]
    as_anon = anonymous.get("/v1/social/posts").json()["items"][0]
    assert (as_author["isOwner"], as_author["viewerVote"]) == (True, 1)
    assert (as_voter["isOwner"], as_voter["viewerVote"]) == (False, -1)
    assert (as_anon["isOwner"], as_anon["viewerVote"], as_anon["viewerVoteRevision"]) == (False, 0, 0)
    response = anonymous.get("/v1/social/posts")
    assert response.headers["cache-control"] == "private, no-store"


def test_my_mogs_and_my_upmogs(author, voter):
    mine = new_post(author)
    theirs = new_post(voter, score=40)
    down = new_post(voter, score=50)
    vote(author, theirs["id"], 1, 0)
    vote(author, down["id"], -1, 0)
    my_posts = [p["id"] for p in author.get("/v1/social/me/posts").json()["items"]]
    upmogs = [p["id"] for p in author.get("/v1/social/me/upmogs").json()["items"]]
    assert my_posts == [mine["id"]]
    assert upmogs == [theirs["id"], mine["id"]]  # newest positive vote first; includes self vote
    voter_upmogs = [p["id"] for p in voter.get("/v1/social/me/upmogs").json()["items"]]
    assert set(voter_upmogs) == {theirs["id"], down["id"]}


def test_state_batch_refresh(author, voter):
    post = new_post(author, score=40)
    gone = new_post(author, score=50)
    author.delete(f"/v1/social/posts/{gone['id']}")
    vote(voter, post["id"], 1, 0)
    body = voter.post("/v1/social/posts/state", json={"ids": [post["id"], gone["id"], "missing-post-1"]}).json()
    statuses = {item["postId"]: item for item in body["items"]}
    assert statuses[post["id"]]["mogScore"] == 2 and statuses[post["id"]]["viewerVote"] == 1
    assert statuses[gone["id"]]["status"] == "deleted" and statuses["missing-post-1"]["status"] == "missing"
    too_many = voter.post("/v1/social/posts/state", json={"ids": [f"post-{i:04d}" for i in range(51)]})
    assert too_many.status_code == 400


def test_fixed_paths_are_not_mistaken_for_ids(author):
    new_post(author)
    assert "headSeq" in author.get("/v1/social/posts/head").json()
    assert author.get("/v1/social/posts/abc").status_code == 404  # too short to be an ID


def test_body_size_limit(author):
    post = new_post(author)
    big = author.put(
        f"/v1/social/posts/{post['id']}/vote",
        content=b'{"value": 1, "expected_vote_revision": 0, "pad": "' + b"x" * 9000 + b'"}',
        headers={"Content-Type": "application/json"},
    )
    assert big.status_code == 413


def test_reconciliation_repairs_drift(author, voter):
    post = new_post(author)
    vote(voter, post["id"], 1, 0)
    with author.app.state.db.write() as conn:
        conn.execute("UPDATE social_posts SET up_count = 9, mog_score = 9 WHERE id = ?", (post["id"],))
    with author.app.state.db.write() as conn:
        fixes = reconcile_counts(conn)
    assert fixes and _counts(author, post["id"]) == (2, 0, 2)


def test_maintenance_expires_sessions_and_dedup(author):
    from app.main import run_maintenance

    new_post(author)
    with author.app.state.db.write() as conn:
        conn.execute("UPDATE request_deduplication SET expires_at = 0")
        conn.execute("UPDATE sessions SET expires_at = 0")
    removed = run_maintenance(author.app)
    assert removed["sessions"] == 1 and removed["dedup"] == 1
    # Posts and votes are unaffected; ownership is simply no longer available.
    assert author.get("/v1/social/posts").json()["items"][0]["isOwner"] is False
