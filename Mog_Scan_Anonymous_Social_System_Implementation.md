# Mog Scan — Anonymous Social System Implementation

**Status:** Implementation specification; this document does not implement or deploy the feature.  
**Date:** September 26, 2026.  
**Scope:** Anonymous result posts, Latest Mogs feeds, Up Mog/Down Mog voting, remembered votes, and deletion of your own posts using only a browser cookie for identity.  
**Related specification:** `file 'Projects/ef/Mog_Scan_1v1_Shared_Leaderboard_Implementation.md'`.  
**Relationship:** This document extends that plan's guest identity, verified results, database, and API. It is the active plan for the social feature, not a replacement for the multiplayer plan. Both describe work to be implemented, not features already deployed. The owner's external approvals and policy decisions are treated as settled.

## 1. Product behavior

Anyone can open the site and browse posts. There is no signup, login, email, password, profile claim, or account-recovery flow.

A visitor can publish one of their own shared-leaderboard results as a **mog**. A mog is a result card with an optional caption. It appears in the Latest Mogs feed and has its own shareable URL. Visitors can **Up Mog** or **Down Mog** it. The author automatically contributes an Up Mog when the post is created, so a new post starts at **1**.

The browser's anonymous cookie determines:

- Which posts belong to the visitor and can be deleted by them.
- Whether they have Up Mogged, Down Mogged, or not voted on a post.
- Which items appear in **My Mogs** and **My Up Mogs**.
- Which leaderboard results the visitor owns and can share.

The database persists the posts and votes; the cookie is the only ownership credential. Do not put a growing list of post IDs or votes into cookies.

### Defaults

| Concern | Implementation |
| --- | --- |
| Identity | Reuse one anonymous player/session across scanning, leaderboard, 1v1, and social |
| Public attribution | Snapshot the result's display name; fall back to `Anonymous`; no profile links |
| Feed ordering | Newest published first; votes do not reorder Latest |
| New-post score | 1, from an actual author vote row |
| Vote values | Up Mog = +1; no vote = 0; Down Mog = -1 |
| Repeated click on selected vote | Remove that vote |
| Switching vote direction | Replace the existing vote; net score changes by 2 |
| Author voting | Same toggle/switch rules as everyone else after the initial automatic Up Mog |
| Post source | An owned, server-recorded result that was published to the shared leaderboard |
| Duplicate posting | One post per owned result, including deleted-post tombstones |
| Caption | Optional plain text, maximum 280 Unicode code points after trimming |
| Editing | No post editing in this release; deletion is available |
| Feed page size | 20; maximum requested size 50 |
| Additional social features | No comments, follows, DMs, notifications, or profile pages in this release |

**Keep the two scores distinct:** a scan may be **78/100** while its post has **12 mogs**. Voting never changes the scan score, tier, leaderboard position, or 1v1 outcome.

## 2. Anonymous cookie identity

### Reuse the planned guest-session system

Use the existing planned `players` and `sessions` tables, not a second social-user system. There must be one `player_id` for this browser across all app features.

On the first action requiring ownership:

1. The frontend calls `POST /api/mog/session`.
2. If the session cookie is valid, reuse its player. Do not create a new identity on each visit.
3. Otherwise, generate a random player ID and a cryptographically random 256-bit session token.
4. Store a SHA-256 hash of the token in `sessions`, associated with the player. Send the raw token only in the cookie.
5. Confirm it on a following `GET /api/mog/session` request before enabling the first publish or vote action.

Cookie configuration:

| Attribute | Value |
| --- | --- |
| Name | `__Host-mog_session` |
| Secure | Yes in production |
| HttpOnly | Yes; JavaScript does not need to read the credential |
| SameSite | Lax |
| Path | `/` |
| Domain | Omit; use a host-only cookie |
| Max-Age | 365 days; renew at most once per day for an active session |

Store matching expiry and renewal timestamps server-side. If another feature has already issued a guest cookie under a different name, add a one-time migration that preserves the same `player_id`; do not silently create a second identity. Use a separately named non-Secure cookie only for explicit HTTP localhost development.

### Ownership rules

Resolve the cookie to a player on every mutation. Never accept `owner_player_id`, an author name, a result name, or a browser-provided `isOwner` flag as authorization.

A mutation without a valid session returns `401 session_required`. It must not silently create an identity and publish content in the same request: that can leave a post without a working owner if the cookie was not accepted.

The frontend's session helper is single-flight within a tab. Serialize initial session creation across tabs using Web Locks where available. Always re-read the server session before the first mutation after bootstrap. If another tab replaces the cookie, clear the current tab's viewer-specific cache and reload session state.

### What persists and what does not

| Event | Result |
| --- | --- |
| Reload or reopen the browser with cookie intact | Votes, My Mogs, and deletion controls return |
| Same browser profile opens another tab | Same identity and ownership |
| Different browser, device, or private session | Different anonymous identity |
| Cookie is cleared, expires, or is blocked | Old posts/votes remain, but their ownership is no longer available in that browser |
| Someone uses the same display name | No ownership or vote history transfers |

Do not add fingerprinting, IP-based identity, localStorage recovery tokens, hidden account recovery, or a login fallback. The contract is one vote per anonymous browser identity, not one verified human.

## 3. Hosting and API integration

Keep the current topology: the React application is served under `/mog-scan/`, the public homepage embeds it, Zo Space exposes same-origin `/api/mog/...` routes, and those routes proxy to the private FastAPI service on `127.0.0.1:8767`.

Add social handlers under FastAPI `/v1/social/...`. Reuse the existing planned session and leaderboard handlers rather than duplicating them under social.

The Space proxies must:

- Forward the anonymous session cookie and required content-type/idempotency headers.
- Forward `Set-Cookie` without exposing its value to frontend JavaScript.
- Support `GET`, `POST`, `PUT`, and `DELETE` as explicitly allowed for each route.
- Validate the exact production origin for mutations and require the resolved session as well.
- Preserve backend status codes and the shared error envelope.
- Send JSON requests with `Accept: application/json` and same-origin credentials.
- Use `Cache-Control: private, no-store` for responses containing `viewerVote`, `isOwner`, or session data. Never share one person's personalized feed response with another visitor through a cache.

No new public backend host, database provider, WebSocket connection, or full-page redirect is needed. Use the same SQLite database and managed service as the multiplayer plan.

## 4. What a post contains

Each public post is an immutable snapshot of a result, not a live pointer to a mutable leaderboard row.

### Content

- Generated public post ID.
- Display-name snapshot from the published result, or `Anonymous`.
- Optional caption.
- Displayed scan score, tier, model version, display-map version, and capture mode.
- Original result time and post publication time.
- Optional own-result photo, if suitable source media exists.
- Up Mog count, Down Mog count, and net mog count.

Keep internal player IDs, session IDs, token hashes, database paths, and ownership credentials out of public representations. Add `isOwner`, `viewerVote`, and `viewerVoteRevision` as viewer-specific fields computed from the request cookie.

### Result source and snapshots

The publish request sends a `result_id`; the backend loads its score and tier itself. Do not accept authoritative score, tier, author, or model fields from the browser.

To publish, the result must:

1. Exist as a completed server result.
2. Belong to the current anonymous player.
3. Have been accepted for publication to the shared leaderboard.
4. Be fully revealable if it came from a 1v1; no posting during a sealed match or unfinished initial reveal.
5. Not already have a social post, including a deleted tombstone.

When a leaderboard best result is later replaced, an existing post does not change. Removing a leaderboard entry also does not silently delete its social post. These are separate actions.

### Remembering leaderboard eligibility

Add a `leaderboard_publications` table recording each result actually accepted into the shared leaderboard, not merely requested. Write it in the same transaction as the leaderboard insert or higher-score replacement. For delayed match publication, write it only when the publication worker releases the result.

This preserves a record of earlier published results even after the current best-score row changes. A lower result rejected by best-score replacement does not become eligible just because someone called the submit endpoint.

For existing shared entries, backfill publication records from their currently referenced results. Browser-only legacy records are not treated as server-verified results.

### Optional photo handling

The normal result card renders from structured score data; an image is not required to publish.

If an owned source photo is available, the composer may offer **Include scan photo**. The backend must locate that photo through the owned result and its participant/media relationship, not through an arbitrary file path or URL supplied by the client. It may copy only the current player's photo, never the opponent's photo.

Copy the image into separate post-media storage so the 1v1's temporary-media expiry does not break a published post. Serve that copy only through the post's media endpoint while the post is active. Do not turn a private match-media endpoint into a public endpoint or put post images into permanent Space assets.

For a solo result with no retained server photo, publish the structured result card without an image. This release does not introduce a separate arbitrary-photo upload feature. If a selected source photo expires before publication, return `source_media_expired`; offer to publish without the photo rather than silently changing the selection.

## 5. Database schema

Use versioned migrations in the shared application database, with foreign keys enabled on every connection. Continue using WAL and bounded busy timeouts. Do not recreate the database when deploying social features.

### Reused tables

- `players`: anonymous owner identity and optional display name.
- `sessions`: cookie-token hashes and expiry.
- `scan_results`: authoritative completed results.
- `leaderboard_entries`: current best published result per player/cohort.
- `request_deduplication`: idempotency records for state-changing operations.

### New tables

| Table | Fields and constraints |
| --- | --- |
| `leaderboard_publications` | `result_id` primary key, `player_id`, `display_name_snapshot`, `first_published_at`; reference the completed result; unique result eligibility record |
| `social_posts` | `feed_seq` integer primary key with AUTOINCREMENT; `id` unique opaque public ID; `owner_player_id`; `source_result_id` unique; author/score/tier/model/display-map/capture-mode snapshots; `result_created_at`; nullable `caption`; nullable `media_id`; `up_count`; `down_count`; `mog_score`; `revision`; `created_at`; nullable `deleted_at` |
| `social_votes` | Composite primary key `(post_id, player_id)`; `value` constrained to -1, 0, or 1; `revision`; `created_at`; `updated_at`; foreign keys to post and player |
| `social_media` | `id` unique generated ID; `owner_player_id`; internal relative file path; MIME type; byte size; width; height; `created_at`; nullable `attached_post_id`; nullable `delete_after` |

Constraints for active posts:

- `up_count >= 0` and `down_count >= 0`.
- `mog_score = up_count - down_count`.
- `scan_score` is an integer from 0 to 100.
- `revision` and vote revisions are nonnegative integers.
- `source_result_id` cannot be reused by another social post.

Store vote value 0 after a removal instead of deleting that vote row. The row's revision is useful for rejecting stale cross-tab writes. An absent row is logically value 0, revision 0. A zero-valued row is not a like and does not appear in My Up Mogs.

### Indexes

- Partial active-post index on `feed_seq DESC` where `deleted_at IS NULL`.
- `(owner_player_id, feed_seq DESC)` for My Mogs, filtered to active posts.
- `(player_id, value, updated_at DESC, post_id)` for My Up Mogs and viewer history.
- `(post_id, value)` for reconciliation of counters.
- `(player_id, first_published_at DESC)` on leaderboard publications.
- Session token hash uniqueness and session-expiry index from the shared identity layer.

Use a server-generated UTC timestamp for display. Use `feed_seq`, not user dates or random IDs, as the definitive feed ordering key.

## 6. Publishing transaction

Entry points:

- **Share as mog** on the visitor's own shared-leaderboard row.
- **Share as mog** after a new result has successfully been added to the shared leaderboard.
- **Share my result** after a completed 1v1, using only the visitor's own eligible result.

Composer: result preview, optional 280-character caption, optional own photo if available, **Post mog**, and Cancel.

### Backend sequence

1. Resolve the session and parse the bounded request.
2. Validate result ownership, leaderboard-publication eligibility, and match reveal completion.
3. Validate caption length as Unicode code points, normalize line endings, and reject nonprinting control characters other than newline. Store/render plain text, not HTML or Markdown.
4. If selected, prepare the owned media copy outside the write transaction. Keep it in a staging state until attached; clean it up if publication fails.
5. Begin a short `BEGIN IMMEDIATE` transaction and recheck all eligibility and duplicate conditions.
6. Insert the post with its frozen result fields and counts `up_count = 1`, `down_count = 0`, `mog_score = 1`, `revision = 1`.
7. Insert `(post_id, owner_player_id, value = 1, revision = 1)` into `social_votes`.
8. Attach the staged media if present.
9. Record the operation's idempotency key, request fingerprint, and post ID.
10. Commit, then return the complete post representation with `isOwner = true` and `viewerVote = 1`.

All database writes above either succeed together or roll back together. A post must never appear without its initial author vote.

### Retry and duplicate semantics

- Repeating the same idempotency key and payload returns the same post, not another post or another self-vote.
- Reusing the same key with different content returns `409 idempotency_conflict`.
- A different key for a result already posted returns `409 result_already_posted` plus its active post ID. The UI opens the existing post instead of claiming a successful new publish.
- A deleted result-post tombstone returns `410 result_post_deleted`. Deleting and reposting the same result does not reset its voting history or bump it to the top of Latest.
- If a reply is lost, retry with the original key. Do not make a fresh publish request with a different key until the first outcome has been reconciled.

The optional filesystem copy is not part of a SQLite transaction. Use a staged-media record and startup/periodic orphan cleanup; never assume a database rollback also deletes a file.

## 7. Exact voting rules

The displayed mog count is the sum of all current votes, including the author's vote. There is no permanent `+1` outside the vote table.

| Existing vote | User clicks | New vote | Change to mog count |
| --- | --- | --- | --- |
| None / 0 | Up Mog | +1 | +1 |
| +1 | Up Mog | 0 | -1 |
| -1 | Up Mog | +1 | +2 |
| None / 0 | Down Mog | -1 | -1 |
| -1 | Down Mog | 0 | +1 |
| +1 | Down Mog | -1 | -2 |

An author starts with +1 but can remove it or switch it using the same rules. A post's net count may be zero or negative; do not clamp it to zero.

Example:

- Author publishes: 1.
- Another visitor Up Mogs: 2.
- A third visitor Down Mogs: 1.
- The second visitor switches from Up to Down: -1.
- The third visitor removes their Down Mog: 0.

### Submit desired state, not a toggle command

Use `PUT /api/mog/posts/:id/vote` with:

- `value`: the desired integer -1, 0, or 1.
- `expected_vote_revision`: the revision of this visitor's vote shown in the current UI.

Do not expose a `toggle` API. A network retry of a toggle can reverse a vote twice. Setting the desired state is stable on retry.

The frontend converts the clicked button into a desired value using the table above. The server remains the authority.

### Atomic update

Within one short write transaction:

1. Resolve the voter from the cookie and read an active post.
2. Read this player's vote, or use value 0/revision 0 for an absent row.
3. If the current value already equals the requested value, return the current authoritative state without changing counts or revisions.
4. Otherwise, require the supplied vote revision to match. A stale revision returns `409 vote_conflict` with the latest viewer/post state.
5. Compute `net_delta = new_value - old_value`.
6. Compute `up_delta = (new_value == 1) - (old_value == 1)` and the equivalent `down_delta` for -1.
7. Insert or update the vote row, incrementing its revision.
8. Update all cached post counts in one statement and increment the post revision.
9. Commit and return `mogScore`, `upCount`, `downCount`, `postRevision`, `viewerVote`, and `viewerVoteRevision`.

Never accept a browser-supplied total. Never authorize a voter using a player ID supplied in the JSON body. Concurrent votes by different visitors must all apply without lost increments.

### Retry and multi-tab behavior

One vote request per post may be in flight in a tab; disable both buttons briefly or queue only the newest desired intent. Do not fire competing optimistic toggles in parallel.

A lost response can be retried with the same desired value and original revision. If that value is already current, the operation is a no-op success. If another tab has since changed it, the revision check prevents an older request from reversing the newer state.

For a conflict, apply the returned server state and let the visitor choose again. Do not automatically resubmit an obsolete intent.

## 8. Latest Mogs feed and remembered interactions

### Home and main-page integration

- The idle home page keeps its scanner entry and existing visual identity, then shows a prominent **Latest Mogs** section.
- Add navigation to **Latest**, **Leaderboard**, **1v1**, and **My Mogs** without replacing the scanner or making social activity a requirement to scan.
- The dedicated Latest view shows the full paginated feed.
- The shared leaderboard offers Share as mog only on the caller's own row and a visible route back to Latest.
- Match and camera screens do not display an updating feed over the active scan or synchronized reveal.

Do not redesign the existing scanner as part of social implementation. Keep matte-black cards, condensed score typography, restrained red active-vote accents, and mobile-first spacing.

### Card layout

1. Author label and relative publication time.
2. Optional caption.
3. Score/tier result card, with an optional owned photo.
4. Up Mog button, net mog count, Down Mog button, and Share link.
5. Delete action only when `isOwner` is true.

Use accessible button names `Up Mog` and `Down Mog`, `aria-pressed` for the current selection, and visible selected states. Label the scan number `78/100` and the net vote number `12 mogs` so users cannot confuse them.

### Stable newest-first pagination

Use keyset pagination, not page-number offsets:

- On page one, record `snapshot_max_seq = MAX(feed_seq)` for the active feed.
- Query active posts with `feed_seq <= snapshot_max_seq`, ordered descending.
- Later pages add `feed_seq < before_seq` using the last row in the preceding page.
- Encode `version`, `snapshot_max_seq`, `before_seq`, and filter in a bounded base64url cursor.
- Validate cursor shape and integer ranges; use bound SQL parameters. A cursor is not an ownership credential.

New posts do not shift the user's existing pages. Deleted posts can create harmless gaps. Voting changes counts but not ordering. De-duplicate loaded cards by public post ID.

When the user is near the top of Latest, check for newer posts every 15 seconds while the page is visible. Show **N new mogs** rather than inserting cards under their pointer. Tapping it reloads page one with a fresh snapshot.

On tab focus, refresh session/viewer state and visible post counts. Pause background polling during camera capture, a 1v1 reveal, hidden tabs, and network backoff. No push-notification or realtime infrastructure is required.

### My Mogs and My Up Mogs

- **My Mogs:** active posts where `owner_player_id` equals the cookie-resolved player.
- **My Up Mogs:** active posts with that player's current vote equal to +1, ordered by most recent positive vote update; includes their automatic self-upvoted posts.
- Down Mogged posts do not appear in My Up Mogs, but their selected Down button is restored wherever they appear.
- Removing an Up Mog removes that post from My Up Mogs.
- These pages use server queries, not a browser-saved list. Clear/reload pagination after a membership-changing action.

For each feed batch, fetch this viewer's vote rows in one query for the returned post IDs. Avoid one database query per card.

## 9. Deleting your own posts

Show a small confirmation: **Delete this mog? This removes the post and its votes.** Deletion does not delete the scan result, leaderboard entry, or match.

`DELETE /api/mog/posts/:id` resolves ownership entirely from the cookie:

1. Read the post and require `owner_player_id == current_player.id`.
2. Start a write transaction; recheck ownership and active/deleted state.
3. Set `deleted_at`, clear public caption, optional media reference, and public result/author snapshots, and increment revision.
4. Delete this post's vote rows and zero its cached counts.
5. Retain a minimal tombstone containing post ID, source result ID, owner ID, feed sequence, and deletion time. This supports retry handling and blocks reposting the same result.
6. Schedule the independent post-media copy for deletion.
7. Commit; return `204`.

An owner retry after deletion also returns `204`. A different player cannot delete it, even if they use the same display name. Public detail/media reads of a deleted post return `410 post_deleted`; unknown IDs return `404 post_not_found`.

A vote racing deletion must either commit first and then be removed, or observe the tombstone and return 410. No vote may resurrect a deleted post or recreate its counters.

Delete media through a bounded cleanup worker in the same managed backend. The endpoint must immediately stop serving deleted-post images even if physical file cleanup runs later. Do not depend on permanent CDN assets for content that needs this behavior.

## 10. API contracts

Public route names below are proxied to corresponding `/v1/social/...` backend handlers, except the reused session and leaderboard routes. Hono dynamic parameters use `/:id`, not bracket syntax.

| Method and route | Request / behavior |
| --- | --- |
| `POST /api/mog/session` | Create/reuse the cookie session; return nonsecret viewer data |
| `GET /api/mog/session` | Confirm persisted cookie and return viewer state; never create identity as a GET side effect |
| `GET /api/mog/posts?cursor=&limit=20` | Active Latest Mogs plus caller-specific vote/ownership fields if a valid cookie exists |
| `GET /api/mog/posts/head?after_seq=` | Count newer active posts, capped for display, and return current head sequence |
| `GET /api/mog/posts/:id` | One active post with caller-specific fields |
| `POST /api/mog/posts` | `{result_id, caption, include_photo}` plus `Idempotency-Key`; create post and author vote atomically |
| `PUT /api/mog/posts/:id/vote` | `{value, expected_vote_revision}`; set desired vote state |
| `DELETE /api/mog/posts/:id` | Delete only the caller's post; no caller-provided owner identity |
| `GET /api/mog/posts/:id/media` | Optional post photo only while its parent post is active |
| `GET /api/mog/me/posts?cursor=&limit=20` | My Mogs; session required |
| `GET /api/mog/me/upmogs?cursor=&limit=20` | Current Up Mogged posts; session required |
| `GET /api/mog/me/shareable-results?cursor=&limit=20` | Owned leaderboard-publication snapshots, existing-post status, and whether own source photo is available |
| `POST /api/mog/posts/state` | At most 50 public post IDs; return current counts/revisions and viewer vote states for visible-card refresh; read-only operation |

Declare `/posts/head` and `/posts/state` before a generic `/:id` handler or constrain ID syntax so fixed paths cannot be mistaken for IDs.

### Post response shape

| Field | Meaning |
| --- | --- |
| `id`, `feedSeq`, `createdAt` | Public post identity, pagination order, publication timestamp |
| `authorLabel`, `caption` | Snapshot text, rendered as text |
| `result` | `score`, `tier`, `modelVersion`, `displayMapVersion`, `captureMode`, `achievedAt` |
| `mediaUrl` | Optional same-origin post-media URL; never a filesystem path |
| `mogScore`, `upCount`, `downCount` | Authoritative voting totals |
| `postRevision` | Monotonically increasing revision of the post representation |
| `viewerVote` | -1, 0, or +1; 0 for a visitor without a valid session |
| `viewerVoteRevision` | Current viewer's row revision, or 0 |
| `isOwner` | Whether the request cookie owns this post |

The list response wraps `items`, `nextCursor`, and `snapshotMaxSeq`. Never expose a session token or author ownership ID in these objects.

### Errors and retries

Use the existing stable envelope with `error.code`, `error.message`, and `request_id`; add optional structured `details` for conflict reconciliation.

- 400: invalid caption, vote, cursor, or payload.
- 401: missing/expired session for an ownership action.
- 403: result/post not owned, or invalid mutation origin.
- 404: unknown post/result.
- 409: stale vote revision, duplicate result post, mismatched idempotency payload, or unfinished match reveal.
- 410: deleted post, deleted-result post tombstone, or selected expired source media.
- 429: retry later; include `Retry-After`.
- 503: service temporarily unavailable.

Do not auto-retry failed authorization, conflicts, deleted resources, or invalid inputs. Bound retries for transient network failures and preserve the original operation intent.

## 11. Frontend state management

Maintain a normalized in-memory post cache keyed by post ID and a shared viewer/session state. This avoids the same post showing different votes in Latest, detail, and My Up Mogs.

For an optimistic vote:

1. Derive the desired value from the current viewer vote.
2. Save the previous cache state and apply the predicted delta to all mounted copies.
3. Mark the post's vote mutation pending and disable conflicting input.
4. Send the desired value with the current viewer-vote revision.
5. Replace counts and viewer vote with the authoritative response.
6. On failure, reconcile from the conflict payload or refetch the post; do not leave an unconfirmed count behind.

Treat post revisions and viewer-vote revisions separately. An old polling response must not overwrite a newer vote selection, and an old vote response must not lower post counts from a newer revision. If session identity changes, discard all viewer-specific cached fields before rendering them for the new session.

Use `BroadcastChannel` for cross-tab invalidation when available, sending only changed post IDs or an identity-changed signal. It is an optimization, not an ownership mechanism. Tabs refetch from the server and also refresh on focus.

Publishing does not optimistically invent a real post or increment the feed. Show a pending composer until the server returns the committed post. On success, close the composer, add the authoritative card, and highlight its selected automatic Up Mog.

## 12. Shareable URLs inside the existing iframe

Canonical public URLs:

- Latest: `https://mog.zo.space/#/mogs`.
- Post detail: `https://mog.zo.space/#/mogs/<post-id>`.
- My Mogs: `https://mog.zo.space/#/my-mogs`.
- My Up Mogs: `https://mog.zo.space/#/my-upmogs`.

Add hash navigation rather than requiring a separate server page route for every post. The application remains in the existing same-origin iframe.

Implement one small bridge between the homepage wrapper and the inner app:

1. On wrapper load/hash change, send the validated route to the iframe.
2. Inner navigation sends a route-change message to the parent; the parent updates its hash and browser history.
3. Validate message origin, source window, message type, and allowed route syntax in both directions.
4. On iframe-ready, resend the current route to handle load timing. Avoid echo loops by ignoring unchanged routes.
5. Back/Forward navigation updates the inner view. A direct post URL loads that post on a fresh browser.
6. In standalone development, use the inner window's own hash.

Copy/Web Share uses the canonical outer URL, never `/mog-scan/index.html` or a local preview hostname. Dynamic per-post link-preview images are outside this milestone; the public URL still opens the correct post.

My pages remain cookie-personalized. Sharing a My Mogs URL does not grant another browser access to the sender's ownership view.

## 13. Implementation file map

Paths below are proposed changes; some modules belong to the unimplemented multiplayer foundation.

| File | Responsibility |
| --- | --- |
| `file 'Projects/ef/src/main.tsx'` | Navigation integration, idle Latest preview, owned-result Share action, scanner cleanup on navigation |
| `file 'Projects/ef/src/api/client.ts'` | Reuse the planned same-origin API helper, session bootstrap, credentials, and error contracts |
| `file 'Projects/ef/src/social/types.ts'` | Post, vote, feed, cursor, and shareable-result contracts |
| `file 'Projects/ef/src/social/api.ts'` | Typed social endpoint calls |
| `file 'Projects/ef/src/social/useSocialStore.ts'` | Normalized posts, viewer state, optimistic voting, revision reconciliation, cross-tab invalidation |
| `file 'Projects/ef/src/social/useFeed.ts'` | Snapshot pagination, load more, new-mogs prompt, visible-card refresh |
| `file 'Projects/ef/src/social/useAppRoute.ts'` | Allowed hash routes and parent/iframe bridge client |
| `file 'Projects/ef/src/components/MogPostCard.tsx'` | Reusable result post presentation and ownership controls |
| `file 'Projects/ef/src/components/MogVoteControls.tsx'` | Exact toggle rules, selected buttons, pending states, accessible count |
| `file 'Projects/ef/src/components/ShareMogSheet.tsx'` | Owned-result preview, caption, photo selection where available, publish retry state |
| `file 'Projects/ef/src/components/MogFeed.tsx'` | Latest list, loading/empty/error states, new-post banner |
| `file 'Projects/ef/src/components/MogPostDetail.tsx'` | Direct-link post view and deleted/not-found states |
| `file 'Projects/ef/src/components/MyMogs.tsx'` | My posts and My Up Mogs views |
| `file 'Projects/ef/src/styles.css'` | Social cards, vote states, responsive layout; preserve current design language |
| `file 'Projects/ef/service/app/sessions.py'` | Reuse cookie identity; add confirmation and rolling expiry behavior |
| `file 'Projects/ef/service/app/social/router.py'` | HTTP contracts and identity dependencies |
| `file 'Projects/ef/service/app/social/service.py'` | Publish, vote, delete, eligibility, and transaction orchestration |
| `file 'Projects/ef/service/app/social/repository.py'` | Parameterized queries, counters, revisions, and feed pagination |
| `file 'Projects/ef/service/app/social/schemas.py'` | Strict request/response validation; reject unknown mutation fields |
| `file 'Projects/ef/service/app/social/media.py'` | Owned-result photo copies, serving, and orphan/deletion cleanup |
| `file 'Projects/ef/service/migrations'` | Social tables, indexes, and leaderboard-publication backfill |
| `file 'Projects/ef/service/tests/test_social.py'` | Transaction, permission, vote, pagination, and retry tests |

Zo Space route changes are managed through Space route tools, not by creating files pretending to be live routes. The homepage change is limited to navigation bridging; API changes are allowlisted proxies.

## 14. Limits and operation

Initial configurable limits, separate from scoring and multiplayer synchronization:

- Session creation: 30 per hour per available trusted network key.
- New posts: 5 per minute and 30 per day per player.
- Vote changes: 60 per minute per player.
- Maximum JSON body for social mutations: 8 KiB.
- Maximum visible-state refresh batch: 50 post IDs.
- Feed refresh: 15 seconds, visible/idle pages only; exponential backoff after failure.
- POST publish idempotency records: retain at least 24 hours; unique result constraint remains permanent.

Use only a network address/header whose provenance is established by the hosting proxy for secondary rate limiting. Do not trust an arbitrary client-supplied forwarded-IP header. Player limits are always enforced independently; network keys are not identity.

Use the same managed-process maintenance task as the multiplayer foundation for expired sessions, unattached media, deleted media, and deduplication expiry. Database backups include social tables alongside matches and leaderboard data. If post photos are enabled, include the independent post-media directory in the backup/restore procedure.

Cached vote counts are maintained on every transaction. Add a reconciliation command that recomputes active-post counts from vote rows and repairs differences under a write lock. Normal feed reads should not repeatedly aggregate the entire vote table.

## 15. Test plan

### Backend and database

- A fresh publish creates exactly one post and one author +1 vote; counts are 1/0/1.
- A failure during self-vote insertion rolls back the post.
- Repeated publish retries do not create duplicates or add votes.
- All six vote transitions match the table, including +1 to -1 changing the total by -2.
- Repeating a desired vote value is a no-op.
- Removing a vote preserves its revision row but removes it from positive-vote queries.
- Author votes use identical rules to other votes.
- Concurrent unique voters produce the exact expected sum without lost increments.
- Stale cross-tab vote writes cannot overwrite newer selections.
- Cookie A cannot share Cookie B's result or delete Cookie B's post, even with matching names.
- Browser-supplied score, owner, or count fields are rejected.
- New best leaderboard results do not mutate older posts.
- An accepted prior publication remains shareable after its leaderboard row is replaced.
- A sealed or still-playing initial 1v1 cannot publish a result early.
- Delete/vote races cannot recreate a post; repeated owner deletion is idempotent.
- Deleted post/media endpoints stop returning content immediately.
- Latest pagination does not duplicate or skip existing active posts when new posts arrive between requests.
- My Up Mogs includes current +1 votes only, including initial author votes.
- Unicode captions enforce one matching frontend/backend code-point limit.
- Counter reconciliation agrees with the source vote rows.

### Frontend and end-to-end

- No login form or signup interruption appears in any social flow.
- Refresh restores selected Up/Down buttons and owner-only delete controls.
- A second browser context sees posts but not the first context's ownership or votes.
- Clearing cookies removes owner controls without deleting the old post.
- Blocked cookies prevent ownership actions with an actionable message; browsing still works.
- Failed optimistic votes restore authoritative state in every mounted card.
- Session changes clear prior viewer-specific state.
- New-post polling shows a banner without moving the feed unexpectedly.
- Direct post links, iframe startup, reload, Back/Forward, and copy/share all resolve correctly.
- 320px and 390px layouts show score, mog count, controls, and captions without horizontal overflow.
- Navigation away from a scan stops camera/tracker work; navigation away from reveal stops audio.
- Backend restart preserves posts, votes, sessions, and deletion ownership.
- Test through the public proxy path, including cookie round-trip, PUT/DELETE forwarding, cache headers, and optional media bytes.

## 16. Build order and completion criteria

### A. Shared foundation

Use or implement the multiplayer plan's database, cookie sessions, completed result records, and shared leaderboard. Add the publication-history table and backfill. Social should not ship with browser-forged result numbers as a substitute for that foundation. Full synchronized 1v1 playback is not a dependency for solo-result social posts.

### B. Publishing and ownership

Implement migrations, result eligibility, snapshots, publish idempotency, automatic author voting, and owner deletion. Complete transaction tests before adding optimistic UI.

### C. Voting

Implement desired-state vote writes, per-player revisions, cached counters, conflicts, and remembered viewer state. Verify concurrent requests and all vote transitions.

### D. Feed and UI

Add Latest, cards, composer, My Mogs, My Up Mogs, and direct-link routing. Add snapshot pagination, optimistic reconciliation, and polling after the basic flow works.

### E. Deployment

Back up the database, apply additive migrations, deploy backend/proxies, and run API checks before uploading the new frontend bundle. Preserve the `/mog-scan/` build base and current real-scoring connection. Upload versioned assets before switching the HTML entry point. Keep the previous frontend for rollback; disable social UI rather than deleting stored social data on rollback.

### Done means

- Visitors never need a login.
- Cookie-backed identity is shared across app features and is the only ownership credential.
- Publishing an eligible result creates one visible post with a selected author Up Mog and count 1.
- Votes toggle/switch correctly, persist across reloads, and never alter the underlying scan score.
- Latest Mogs is visible on the idle home page and in its own paginated view.
- The same cookie restores My Mogs, My Up Mogs, and deletion rights.
- Other visitors cannot delete posts they do not own.
- Result snapshots survive leaderboard replacement, and posts/votes survive backend restart.
- Shared links resolve to the right post inside the existing app wrapper.
- No scanner, card export, local leaderboard, local edit, or 1v1 behavior is removed by this feature.
