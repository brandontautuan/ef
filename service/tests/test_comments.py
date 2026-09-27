"""Comments on mogs and their own Up Mog / Down Mog counters."""

from __future__ import annotations

import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.db import now_ms
from app.social import comments as comment_service
from app.social.comments import reconcile_comment_counts
from tests.helpers import new_post, player_id_of, publish_to_board, seed_result, start_session, vote


@pytest.fixture
def author(client):
    start_session(client)
    return client


@pytest.fixture
def other(make_client):
    c = make_client()
    start_session(c)
    return c


def comment(client, post_id, body="nice mog", key=None):
    return client.post(
        f"/v1/social/posts/{post_id}/comments", json={"body": body},
        headers={"Idempotency-Key": key or secrets.token_urlsafe(12)},
    )


def cvote(client, comment_id, value, expected):
    return client.put(f"/v1/social/comments/{comment_id}/vote", json={"value": value, "expected_vote_revision": expected})


def post_counts(client, post_id):
    return client.get(f"/v1/social/posts/{post_id}").json()["post"]


def test_new_comment_starts_at_one_with_author_up_mog(author, other):
    post = new_post(author)
    publish_to_board(other, seed_result(other, 30), "Commenter")  # sets a display name
    r = comment(other, post["id"], "  hello\r\nthere  ")
    assert r.status_code == 201
    c = r.json()["comment"]
    assert c["body"] == "hello\nthere" and c["authorLabel"] == "Commenter"
    assert (c["mogScore"], c["upCount"], c["downCount"], c["viewerVote"], c["viewerVoteRevision"]) == (1, 1, 0, 1, 1)
    assert c["isAuthor"] is True and c["isPostAuthor"] is False
    assert r.json()["commentCount"] == 1
    assert post_counts(author, post["id"])["commentCount"] == 1
    op = comment(author, post["id"], "thanks").json()["comment"]
    assert op["isPostAuthor"] is True and op["authorLabel"] == "Tester"


def test_anonymous_label_without_display_name(author, other):
    post = new_post(author)
    assert comment(other, post["id"]).json()["comment"]["authorLabel"] == "Anonymous"


@pytest.mark.parametrize("existing, desired, delta", [(0, 1, 1), (1, 0, -1), (-1, 1, 2), (0, -1, -1), (-1, 0, 1), (1, -1, -2)])
def test_comment_vote_transitions(author, other, existing, desired, delta):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    revision, before = 0, c["mogScore"]
    if existing:
        start = cvote(other, c["id"], existing, 0).json()
        revision, before = start["viewerVoteRevision"], start["mogScore"]
    body = cvote(other, c["id"], desired, revision).json()
    assert body["viewerVote"] == desired and body["mogScore"] - before == delta
    assert body["mogScore"] == body["upCount"] - body["downCount"]


def test_comment_and_post_counters_are_independent(author, other):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    cvote(other, c["id"], -1, 0)
    cvote(author, c["id"], 0, 1)
    after = post_counts(other, post["id"])
    assert (after["mogScore"], after["upCount"], after["downCount"]) == (1, 1, 0)
    vote(other, post["id"], 1, 0)
    listed = other.get(f"/v1/social/posts/{post['id']}/comments").json()["items"][0]
    assert listed["mogScore"] == -1 and listed["viewerVote"] == -1


def test_repeat_is_noop_and_stale_revision_conflicts(author, other):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    first = cvote(other, c["id"], 1, 0).json()
    again = cvote(other, c["id"], 1, 0).json()
    assert again["commentRevision"] == first["commentRevision"] and again["viewerVoteRevision"] == 1
    cvote(other, c["id"], -1, 1)
    stale = cvote(other, c["id"], 0, 1)
    assert stale.status_code == 409 and stale.json()["error"]["details"]["viewerVote"] == -1


def test_author_can_remove_and_flip_own_comment_vote(author):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    assert cvote(author, c["id"], 0, 1).json()["mogScore"] == 0
    assert cvote(author, c["id"], -1, 2).json()["mogScore"] == -1


def test_comment_idempotency(author):
    post = new_post(author)
    first = comment(author, post["id"], "same", key="comment-key-0001")
    retry = comment(author, post["id"], "same", key="comment-key-0001")
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.json()["comment"]["id"] == first.json()["comment"]["id"] and retry.json()["commentCount"] == 1
    mismatch = comment(author, post["id"], "different", key="comment-key-0001")
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"


def test_comment_validation(author):
    post = new_post(author)
    emoji = "🔥"
    assert comment(author, post["id"], emoji * 500).status_code == 201
    too_long = comment(author, post["id"], emoji * 501)
    assert too_long.status_code == 400 and too_long.json()["error"]["code"] == "invalid_comment"
    assert comment(author, post["id"], "   \n ").status_code == 400
    assert comment(author, post["id"], "bell\x07").status_code == 400
    extra = author.post(f"/v1/social/posts/{post['id']}/comments", json={"body": "x", "author": "Someone"}, headers={"Idempotency-Key": "abcdefgh12"})
    assert extra.status_code == 400
    no_key = author.post(f"/v1/social/posts/{post['id']}/comments", json={"body": "x"})
    assert no_key.status_code == 400


def test_session_required(client):
    start_session(client)
    post = new_post(client)
    client.cookies.clear()
    assert comment(client, post["id"]).status_code == 401
    assert client.get(f"/v1/social/posts/{post['id']}/comments").status_code == 200  # reading is public


def test_delete_comment_author_only(author, other):
    post = new_post(author)
    c = comment(other, post["id"]).json()["comment"]
    cvote(author, c["id"], 1, 0)
    assert author.delete(f"/v1/social/comments/{c['id']}").status_code == 403  # even the post's owner
    first = other.delete(f"/v1/social/comments/{c['id']}")
    assert first.status_code == 200 and first.json()["commentCount"] == 0
    assert other.delete(f"/v1/social/comments/{c['id']}").json()["commentCount"] == 0  # idempotent
    assert other.get(f"/v1/social/posts/{post['id']}/comments").json()["items"] == []
    assert cvote(author, c["id"], -1, 1).status_code == 410
    with other.app.state.db.read() as conn:
        row = conn.execute("SELECT body, author_label FROM social_comments WHERE id = ?", (c["id"],)).fetchone()
        votes = conn.execute("SELECT COUNT(*) FROM social_comment_votes WHERE comment_id = ?", (c["id"],)).fetchone()[0]
    assert row["body"] is None and row["author_label"] is None and votes == 0


def test_deleting_post_removes_comments(author, other):
    post = new_post(author)
    c = comment(other, post["id"]).json()["comment"]
    author.delete(f"/v1/social/posts/{post['id']}")
    assert other.get(f"/v1/social/posts/{post['id']}/comments").status_code == 410
    assert comment(other, post["id"]).status_code == 410
    assert cvote(other, c["id"], 0, 1).status_code == 410
    with author.app.state.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM social_comments WHERE deleted_at IS NULL").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM social_comment_votes").fetchone()[0] == 0


def test_pagination_oldest_first(author, monkeypatch):
    monkeypatch.setattr(author.app.state.comment_limiter, "_max", 100)
    post = new_post(author)
    ids = [comment(author, post["id"], f"c{i}").json()["comment"]["id"] for i in range(5)]
    page1 = author.get(f"/v1/social/posts/{post['id']}/comments?limit=2").json()
    page2 = author.get(f"/v1/social/posts/{post['id']}/comments?limit=2&cursor={page1['nextCursor']}").json()
    page3 = author.get(f"/v1/social/posts/{post['id']}/comments?limit=2&cursor={page2['nextCursor']}").json()
    assert [c["id"] for p in (page1, page2, page3) for c in p["items"]] == ids and page3["nextCursor"] is None
    other_post = new_post(author, score=99)
    wrong = author.get(f"/v1/social/posts/{other_post['id']}/comments?cursor={page1['nextCursor']}")
    assert wrong.status_code == 400


def test_viewer_fields_personal(author, other, make_client):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    cvote(other, c["id"], -1, 0)
    anon = make_client()
    mine = author.get(f"/v1/social/posts/{post['id']}/comments").json()["items"][0]
    theirs = other.get(f"/v1/social/posts/{post['id']}/comments").json()["items"][0]
    nobody = anon.get(f"/v1/social/posts/{post['id']}/comments").json()["items"][0]
    assert (mine["isAuthor"], mine["viewerVote"]) == (True, 1)
    assert (theirs["isAuthor"], theirs["viewerVote"]) == (False, -1)
    assert (nobody["isAuthor"], nobody["viewerVote"]) == (False, 0)
    assert player_id_of(author) not in str(mine)


def test_comment_rate_limit(author, other):
    post = new_post(author)
    for i in range(10):
        assert comment(other, post["id"], f"c{i}").status_code == 201
    limited = comment(other, post["id"], "one too many")
    assert limited.status_code == 429 and limited.headers["retry-after"] == "60"


def test_concurrent_comment_votes(author):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    db = author.app.state.db
    now = now_ms()
    players = [f"cv{i}" for i in range(30)]
    with db.write() as conn:
        conn.executemany("INSERT INTO players (id, created_at, updated_at) VALUES (?, ?, ?)", [(p, now, now) for p in players])
    barrier = threading.Barrier(len(players))

    def cast(player):
        barrier.wait()
        comment_service.set_comment_vote(db, comment_id=c["id"], player_id=player, value=1, expected_revision=0)

    with ThreadPoolExecutor(max_workers=len(players)) as pool:
        list(pool.map(cast, players))
    listed = author.get(f"/v1/social/posts/{post['id']}/comments").json()["items"][0]
    assert listed["mogScore"] == 31 and listed["upCount"] == 31
    with db.write() as conn:
        assert reconcile_comment_counts(conn) == []


def test_reconcile_repairs_comment_drift(author):
    post = new_post(author)
    c = comment(author, post["id"]).json()["comment"]
    with author.app.state.db.write() as conn:
        conn.execute("UPDATE social_comments SET up_count = 5, mog_score = 5 WHERE id = ?", (c["id"],))
        conn.execute("UPDATE social_posts SET comment_count = 7 WHERE id = ?", (post["id"],))
    with author.app.state.db.write() as conn:
        assert len(reconcile_comment_counts(conn)) == 2
    assert post_counts(author, post["id"])["commentCount"] == 1
    assert author.get(f"/v1/social/posts/{post['id']}/comments").json()["items"][0]["mogScore"] == 1


def test_state_refresh_includes_comment_count(author, other):
    post = new_post(author)
    comment(other, post["id"])
    state = other.post("/v1/social/posts/state", json={"ids": [post["id"]]}).json()["items"][0]
    assert state["commentCount"] == 1
