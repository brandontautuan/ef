# Mog Scan — Invite-Code 1v1 and Shared Leaderboard Implementation

**Status:** Implementation specification only; no feature code or deployment changes made by this document.  
**Date:** September 26, 2026.  
**Upstream baseline:** `dfd305e108f4890274b488d6134f28fa440d70f1`, verified as the latest upstream commit when preparing this specification.  
**Live-integration baseline:** local commit `5047ce21b9be421657da6fa9dcf60cd9ecd011ac`.  
**Scope:** Two-device invite-code matches, synchronized photo-based “Who Mogs Who?” playback, and a database-backed shared leaderboard on https://mog.zo.space/.  
**Precedence:** This is the active plan for this feature. The earlier local-leaderboard scope remains useful for the existing local mode, but its local-only restriction does not govern the new shared mode. Earlier informal outlines are superseded. The owner's external approvals and policy decisions are treated as settled; this document focuses on implementation.

## 1. What will ship

A visitor chooses **Create 1v1**, receives a code, and gives it to another visitor. The second visitor chooses **Join 1v1** and enters that code. Both appear in one lobby, scan independently, and see each other's progress without seeing scores. Once both scans and photo downloads finish, each presses **Ready for reveal**. Both devices count down to the same server-selected start time and play the existing photo edit, soundtrack, stamp, and result sequence together.

The shared leaderboard stores submitted results on the server, not in a particular browser. Existing solo scans, photo uploads, downloadable cards, and the local “Who Mogs Who?” player remain available.

### Implementation defaults

| Decision | Initial implementation |
| --- | --- |
| Match size | Exactly two participants; creator is A, joiner is B |
| Joining | Eight-character code, displayed as `ABCD-EFGH`; case-insensitive |
| Invite lifetime | 10 minutes to join; closed immediately when the second slot is claimed |
| Pending match lifetime | 30 minutes from creation |
| Scan mode in a 1v1 | Fresh live-camera scan, three accepted frames per person |
| Solo scan modes | Preserve both live camera and photo upload |
| Reveal format | Existing 15.4-second browser-rendered photo/audio edit, not a newly rendered MP4 |
| Reveal ordering | A then B on both devices; never reverse according to which device is viewing |
| Scheduling | Five-second lead time after both are ready; server timestamps control playback |
| Identity | Lightweight guest session; no email-account dependency for this release |
| Shared leaderboard | Best explicitly submitted score per guest player and scoring cohort |
| Leaderboard cohorts | Separate model version, display-map version, and capture mode |
| Match photos | Private match media; default expiry 24 hours after upload |
| Completed match metadata | Retain 30 days by default; leaderboard entries persist independently |
| Local records | Keep locally; do not automatically publish old records |

Invite codes connect a pair of users. They are **not** an access gate for the homepage or the solo scanner.

## 2. Verified starting point and protected behavior

The latest upstream commit already contains:

- A local leaderboard with name, score, tier, model version, and timestamps in `localStorage` under `mog_scan.leaderboard.v1`.
- A separate IndexedDB photo store named `mog_scan_leaderboard_photos`.
- A “Who Mogs Who?” player that loads two saved local photos and compares their saved scores.
- A deterministic 15.4-second scene timeline, bundled music, a “Mogged” stamp, mute, swap, and replay controls.

It does **not** contain networked matches, a shared database, player sessions, or cross-device synchronization. The deployed checkout predates those upstream local-leaderboard additions.

### Merge requirements

Merge upstream into the local integration branch rather than replacing the checkout with upstream files. The upstream scanner and live scanner differ in important ways:

| Concern | Upstream baseline | Behavior to keep on the deployed site |
| --- | --- | --- |
| Missing score endpoint | Random development fallback | Fail closed; do not invent a score |
| Display conversion | Native 2.3–3.9 mapped to 0–100 | Preserve live native 1–5 mapped to 0–100 |
| Requests | Ordinary scoring fetch | Preserve JSON `Accept` header and same-origin proxy |
| Deployment | Generic Vite app | Preserve `/mog-scan/` asset base and homepage iframe |

Do not change the active model, crop geometry, quality gates, existing tier thresholds, capsule animation, face-free card option, or solo camera cleanup as part of the multiplayer work. Match scores use the same deployed conversion as solo results. Give that conversion a distinct display-map version so it cannot be confused with the upstream heuristic map.

## 3. Architecture

```text
Browser A                         Browser B
    |                                 |
    +---------- mog.zo.space ----------+
                     |
         Zo Space same-origin API proxies
                     |
         FastAPI on 127.0.0.1:8767
          /            |             \
    scoring runner   match logic    leaderboard logic
                         |                |
                         +---- SQLite ----+
                         |
                private match-photo files
```

### Keep the existing hosting arrangement

- The static React bundle remains under `/mog-scan/`.
- The existing homepage continues to embed `/mog-scan/index.html`.
- The existing `/api/ef-score` endpoint continues to support legacy solo scoring.
- Add a family of `/api/mog/...` Space API routes proxying to the same private FastAPI service.
- Extend the existing managed service, `svc_ya6lioVGyrs`, rather than starting another inference process.
- No new Zo Site, public database port, external database subscription, or server-side video renderer is required.

### Transport choice: timestamp synchronization over short polling

Use ordinary HTTPS requests for the first version. This fits the verified deployment: the existing Space route is a bounded request/response proxy. WebSocket upgrades and streaming behavior through that proxy have not been verified, so they should not be a prerequisite.

Polling communicates state; it does **not** drive video frames. Both browsers animate locally against one agreed future timestamp. Therefore a half-second polling interval does not imply half-second playback drift.

Use one combined heartbeat/state-sync request per active client:

- Lobby and scanning: once per second.
- Media loading, preparation, and countdown: every 500 ms.
- Playback: once per second for connection status; animation continues independently.
- Completed match: stop polling until the user asks for a shared replay.
- Hidden tab or failed connection: stop readiness, use bounded retry backoff, and resynchronize on return.

Do not overlap requests. Polling should return a compact unchanged response when the match revision has not changed. If future scale warrants WebSockets or SSE, replace only the transport adapter; retain the same revisions, state transitions, and scheduled-start protocol.

## 4. Player identity and ownership

On first interaction, create a guest player and an opaque random session token. Store only the token hash server-side. Deliver the raw token in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie scoped to `/`.

The inner application and API endpoints share `mog.zo.space`, so normal same-origin cookies work inside the existing iframe. The Space proxy must forward the session cookie to FastAPI and forward `Set-Cookie` back without exposing the token in JSON or URLs.

- Display names are labels, not ownership credentials.
- Normalize whitespace and retain the current 2–20 character limit.
- Two people may have the same display name; they still have different player IDs.
- Only a participant can read or mutate their match or retrieve its photos.
- The invite code permits claiming the open guest slot, not reading arbitrary match data.
- The same player cannot occupy both slots in a network match. Preserve same-device comparisons in the existing local edit mode instead.
- A shared entry remains visible from other devices. Managing it uses its owner's session. Cross-device account recovery is outside this guest-session release; losing browser cookies must not delete the server entry or transfer ownership to someone with the same name.

Mutations require same-origin validation plus session authorization. Origin validation alone is not authentication. Apply separate request limits to joining, creating, scoring, and synchronization so ordinary match polling does not consume the scoring allowance.

## 5. Database and filesystem layout

Use Python's built-in SQLite support. Start with one managed FastAPI process and separate short-lived database connections per request/worker. Enable foreign keys, WAL mode, and a bounded busy timeout. Use `BEGIN IMMEDIATE` for slot claims and state transitions; never wait on inference or networking while holding a write transaction.

Proposed storage:

- `file 'Projects/ef/service/data/mog.sqlite3'` — durable application data.
- `file 'Projects/ef/service/data/match-media'` — temporary photo files, addressed by generated IDs.
- `file 'Projects/ef/service/data/backups'` — consistent database snapshots.
- `file 'Projects/ef/service/migrations'` — versioned schema migrations.

Ignore runtime data and backups in Git. Do not place match photos in public Space assets or the Vite bundle.

### Tables

| Table | Essential columns and constraints |
| --- | --- |
| `players` | `id`, `display_name`, `created_at`, `updated_at` |
| `sessions` | `token_hash` unique, `player_id`, `expires_at`, `created_at` |
| `matches` | `id`, `invite_code` unique, `state`, `revision`, `model_version`, `display_map_version`, `created_at`, `join_expires_at`, `expires_at`, `completed_at` |
| `match_participants` | `match_id`, `slot`, `player_id`, `result_id`, `media_id`, `ready_revision`, `last_seen_at`; unique `(match_id, slot)` and `(match_id, player_id)` |
| `scan_results` | `id`, `player_id`, optional `match_id`, `capture_mode`, `score`, `tier`, `model_version`, `display_map_version`, `created_at`; completed server results only |
| `match_media` | `id`, `match_id`, `owner_player_id`, `relative_path`, `mime`, `width`, `height`, `expires_at`, `created_at` |
| `playback_runs` | `id`, `match_id`, `generation`, `kind`, `state`, frozen participant/result/media IDs, winner, score difference, timeline/asset versions, `start_at`, `ack_deadline`, `completed_at`; unique `(match_id, generation)` |
| `playback_acks` | `run_id`, `player_id`, `received_at`; unique `(run_id, player_id)` |
| `leaderboard_entries` | `id`, `player_id`, `result_id`, `score`, `tier`, cohort versions/mode, `achieved_at`, `published_at`; unique `(player_id, model_version, display_map_version, capture_mode)` |
| `pending_publications` | `result_id` unique, `player_id`, earliest publication time, processed state; separates submission intent from reveal timing |
| `request_deduplication` | `player_id`, operation, idempotency key, request fingerprint, resulting resource ID, expiry; unique operation/key per player |
| `schema_migrations` | Migration version and applied timestamp |

Do not store face landmarks or continuous video. Keep incomplete frame-score samples in a bounded, expiring in-memory scan-session registry. Completed results, match progress, and scheduled playback survive process restart; an interrupted incomplete scan must restart.

### Database mechanics

1. Apply forward-only migrations at service startup before admitting traffic.
2. Use an atomic transaction to claim the second match slot. Two simultaneous join attempts cannot both succeed.
3. Enforce monotonic match revisions. Stale client writes return the current revision with a conflict response.
4. Freeze a playback snapshot once preparation begins. Later profile-name changes or leaderboard updates cannot alter that match's edit.
5. Make publication and completion idempotent using database constraints, not browser flags.
6. Use SQLite's backup API for snapshots; do not copy only the main database file while WAL writes are active.

## 6. Match flow and state machine

### User-visible flow

1. **Create:** choose a display name, create match, show code and “Waiting for opponent.”
2. **Join:** enter a normalized code; the backend claims slot B and returns the shared lobby.
3. **Scan:** each participant starts their own camera explicitly. Either can finish first.
4. **Waiting:** a finished participant sees “Scan locked — waiting for opponent.” No solo result panel, roast, or score card opens in match mode.
5. **Prepare:** once both finish, load both match photos, soundtrack, stamp, fonts, and timeline version on each device.
6. **Ready:** each participant taps “Ready for reveal,” which also unlocks audio on that device.
7. **Countdown:** the backend schedules and commits one start time after the readiness handshake.
8. **Playback:** both display the same ordered photos and the same timeline position.
9. **Result:** show winner/tie, scores, difference, shared-leaderboard action, Replay together, and Rematch.

### States

| State | Transition condition |
| --- | --- |
| `waiting_for_opponent` | Created with only A; code is joinable |
| `scanning` | B joined; each participant can begin or retry their incomplete scan |
| `preparing` | Both results and photos exist; clients load assets and acknowledge readiness |
| `scheduled` | Candidate run exists with a future start time; both clients must acknowledge it |
| `playing` | Candidate is committed and server time reaches `start_at` |
| `completed` | Server time reaches `start_at + 15,400 ms` |
| `cancelled` | Participant leaves before playback is committed |
| `expired` | Join or pending-match deadline passes |

Participant progress is separate from match state: `not_started`, `scanning`, `locked`, `loading_media`, `ready`, and `disconnected`.

A rescan is allowed only before that participant's result has been locked. After both results are prepared, they are immutable; a rematch creates a new match. This avoids one player quietly replacing a score after learning the opponent's result.

### Invite codes

Generate eight characters from a 32-symbol alphabet excluding ambiguous letters. Use cryptographic randomness, check collisions, and show a hyphen for readability. Normalize spaces, hyphens, and case when joining. Store the code in the private database so an authenticated creator can recover the same invitation after refresh or an idempotent retry. Return it only to the creator while the guest slot is open; omit it from general snapshots and logs. Reject expired, full, or cancelled matches without returning participant details.

Creating and joining accept idempotency keys. A network retry must return the same match/slot instead of creating duplicates. Refreshing restores the participant's active match through the session endpoint.

## 7. Scoring integration and result authority

The backend, not the browser, determines the score saved to a match or shared board. A write endpoint must never accept an arbitrary browser-supplied `score`, `tier`, or `winner` as authoritative.

### Registered scan sessions

Introduce a registered scan path for shared results:

1. The client requests a scan session with `purpose` (`solo` or `match`), capture mode, and optional match ID.
2. The backend generates a scan ID and binds it to the authenticated player, purpose, expected model/display-map versions, and required frame count.
3. The existing camera capture and quality gates produce selected 640 × 640 JPEG crops.
4. A new registered-frame endpoint receives the scan ID, frame sequence, and crop. It reuses the existing decoding, admission control, inference, and validation functions.
5. The backend accumulates three successful distinct frame sequences for live mode, or one for the existing solo-upload mode. The first three accepted live frames finalize the scan automatically.
6. It calculates the result, writes one completed `scan_results` record, and locks it to the participant if this is a match.

Keep legacy `/v1/score` and `/api/ef-score` behavior compatible for old clients. New shared flows use the registered endpoint. During rollout, local/legacy results can still be displayed, but they are not eligible for authoritative shared publication.

Start camera permission from the user's click while scan-session registration happens concurrently. Do not move camera access behind a long asynchronous request. Do not transmit frames until registration has succeeded. Registration failure stops the camera and offers a normal retry.

### Match responses

For a match frame, return only accepted-frame count, required count, status, request ID, and a result reference when complete. Do not send `native_score`, the displayed score, tier, or winner in scan/progress responses. The client stores a match-scan acknowledgment rather than a normal solo `Prediction`.

This requires two completion paths in the scanner:

- **Solo:** show the usual result and card UI, using the registered server result for shared eligibility.
- **Match:** stop all camera resources, return to the lobby, and show a locked status.

### Aggregation and version consistency

Use the median of three live native scores and preserve the deployed display conversion:

`displayed = clamp(floor(((median - 1) / 4) * 100 + 0.5), 0, 100)`

Python's ordinary `round()` uses different half-way rounding from JavaScript's `Math.round()`. Implement the explicit formula above and test boundary cases. Preserve tier thresholds: 27, 43, 60, 74, 81, 90, and 97.

Snapshot both model version and display-map version when a match begins. Do not combine results produced by different versions. If deployment changes the model before a match finishes, return `model_changed` and require a new match instead of comparing incompatible results.

Enforce scan ownership, frame-count limits, and sequence uniqueness server-side. Concurrent retries for the same sequence share one in-flight operation or return its cached acknowledgment; they must not run extra samples or increment the count twice. A finished scan cannot be submitted as another person's result or attached to multiple matches.

### Reveal photo

For match scans only, retain the last accepted selected crop as the reveal photo. This matches the current local player, which saves the current frame canvas. Store one image, not all three samples, and save its generated media ID with the finalized result. If media persistence fails, do not leave a ready result without a usable photo; return a recoverable failure and clean up any orphaned temporary file.

The photo is a presentation frame from the scan. The score remains the median of all three samples, not a separate score for that single photo.

## 8. Synchronized playback protocol

### 8.1 Preserve the exact edit

Reuse the existing scene timing and styling:

| Offset from start | Visual behavior |
| --- | --- |
| 0–3,600 ms | Subject A introduction |
| 3,600–7,200 ms | Subject B introduction |
| 7,200–8,100 ms | VS sequence |
| 8,100–11,700 ms | Suspense sequence |
| 10,800–11,700 ms | Existing loser-specific “Mogged” stamp, when not tied |
| 11,700–14,400 ms | Winner/tie and score reveal |
| 14,400–15,400 ms | Outro/audio fade |

The stamp reveals the loser at 10.8 seconds, before the main result at 11.7 seconds. Preserve that upstream behavior intentionally; synchronize both milestones and do not describe 11.7 seconds as the first possible visual disclosure.

### 8.2 Server-clock estimation

Do not trust two devices' wall clocks to agree. A clock endpoint returns backend receive and send timestamps. The client records request-send and response-receive times using a fixed epoch anchor plus `performance.now()`.

For one sample, let `t0` and `t3` be client send/receive times, and `t1` and `t2` be server receive/send times:

- Estimated server offset: `((t1 - t0) + (t2 - t3)) / 2`.
- Estimated network round trip: `(t3 - t0) - (t2 - t1)`.

Take five short samples and use the median offset of the three lowest-latency samples. Refresh the estimate in the lobby and immediately before readying. Derive ongoing time from the monotonic browser clock so a phone's wall-clock adjustment cannot jump the edit. Freeze the playback anchor during the 15.4-second run; re-anchor only on an explicit reconnect/resume.

### 8.3 Asset and audio preparation

Before enabling Ready:

- Fetch both authorized photo blobs and wait for image decoding.
- Fetch and decode the bundled audio into an `AudioBuffer`.
- Load the stamp and fonts used by the edit.
- Confirm both clients support the run's timeline and asset versions.
- Obtain a recent clock estimate.

On the Ready click, create or resume an `AudioContext` synchronously from that gesture, then submit readiness. If audio cannot be enabled, offer “Ready muted” rather than silently delaying one device. Muting remains local; the soundtrack position remains synchronized.

Add `autoplay` to the homepage iframe's existing camera permission allowance as an additive wrapper change. This supports the audio flow but does not replace the per-device user gesture required by browsers.

### 8.4 Two-step scheduling

1. Both participants report ready for the current frozen content revision and have recent heartbeats.
2. In one transaction, the server creates a candidate `playback_run` with a new generation, `start_at = server_now + 5,000 ms`, and `ack_deadline = start_at - 2,000 ms`.
3. Both clients receive the candidate, validate their assets/audio context, and acknowledge its exact generation.
4. If both acknowledgments arrive before the deadline, the server commits the run. Only then does it release the frozen outcome payload to both participants.
5. If the deadline is missed, abandon that candidate. Both clients discard its timers and obtain a new candidate after readiness is restored. Scores remain frozen.
6. Clients start only after observing a committed run. They never start merely because a candidate timestamp has arrived.

Once committed, a run's start time does not move. A last-moment network loss cannot be detected perfectly by the other device; late clients catch up rather than causing an unannounced unilateral restart.

### 8.5 Frame and audio scheduling

Refactor the player so elapsed time is derived from `estimatedServerNow - start_at`, clamped to 0–15,400 ms. `requestAnimationFrame` draws the scene for that elapsed value; it does not increment a counter or use a separate start time created after an audio fetch.

Prepare audio in advance and schedule its source against the audio context's clock using the same remaining time until `start_at`. If the client is late, start the buffer at the corresponding offset rather than replaying from zero. Schedule the fade at 14.4 seconds and stop at 15.4 seconds relative to the shared timeline, accounting for any late offset.

Do not reuse the current helper unchanged: it fetches, decodes, and starts audio immediately, while the visual clock is created afterward. Split it into prepare, schedule, set-mute, and stop operations.

### 8.6 Outcome payload and secrecy boundary

The committed playback snapshot includes A/B display-name snapshots, private photo references, both displayed scores and tiers, winner/tie, difference, start time, generation, and timeline/asset versions. Both devices receive identical values.

Scores are unavailable before both people finish and the run is committed. During the committed countdown, the normal interface still hides them. Because the browser needs the complete payload for reliable local animation, a technically determined participant could inspect it before the visual reveal. This is a synchronized presentation, not a cryptographic spoiler-proof protocol. Do not add delayed outcome fetching at 11.7 seconds; that would make the visible result depend on network arrival time.

### 8.7 Reconnects, background tabs, and replay

- Before commitment: losing readiness or a recent heartbeat prevents a start; preparation can resume.
- After commitment: refreshing or reconnecting retrieves the same generation and seeks to current elapsed time.
- Returning after 15.4 seconds shows the completed result, with Replay together available.
- Hidden/background tabs mute and stop unnecessary rendering. On return, seek to the current timeline; suspended mobile browsers cannot be promised simultaneous display.
- Replay together creates another readiness/scheduling generation over the same frozen results. It never scores again or republishes leaderboard entries.
- Rematch creates a fresh match and fresh scan sessions. It does not overwrite the previous result.

Acceptance target: on foreground devices with fully loaded media and stable connections, start/stamp/result milestones should differ by no more than 250 ms at the 95th percentile in a measured two-device test set. This is a test target, not a guarantee for every network or backgrounded browser.

## 9. API contract

The paths below are public-facing, same-origin paths. Each maps to an equivalent `/v1/...` FastAPI route. Every client fetch sets `Accept: application/json` where JSON is expected and uses same-origin credentials.

| Method and path | Request / response responsibility |
| --- | --- |
| `POST /api/mog/session` | Create guest session if absent; return player and current active match; idempotent for an existing session |
| `PATCH /api/mog/player` | Update the caller's display name; never transfer records by matching a name |
| `GET /api/mog/clock` | Backend receive/send times for offset sampling; no-store |
| `POST /api/mog/matches` | Create match and return its ID, invite code, revision, and expiry |
| `POST /api/mog/matches/join` | Normalize code and atomically claim B; return membership and state |
| `GET /api/mog/matches/:id` | Authorized match snapshot; redact outcome until committed |
| `POST /api/mog/matches/:id/sync` | Heartbeat, last-seen revision, optional candidate acknowledgment; return server time and current state/candidate/committed run |
| `POST /api/mog/matches/:id/ready` | Ready/unready for a particular prepared content revision; reject missing scan/media or stale assets |
| `POST /api/mog/matches/:id/leave` | Cancel an uncommitted match for both; after commitment leave the view without rewriting the result |
| `POST /api/mog/matches/:id/replay` | Request shared replay; both participants must ready for the new run |
| `POST /api/mog/matches/:id/rematch` | Create one linked rematch on idempotent retry; other participant explicitly accepts via its code |
| `POST /api/mog/scans` | Create owned scan session; return required frame count and opaque scan ID |
| `POST /api/mog/scans/:id/frames` | Multipart frame; return progress, then an owned server result reference; match results remain redacted |
| `GET /api/mog/media/:id` | Authenticated match-photo bytes; membership and expiry checked; no-store |
| `GET /api/mog/leaderboard` | Paginated shared rows for a cohort plus optional caller rank; no photos |
| `POST /api/mog/leaderboard` | Submit an owned result ID; server chooses insert/update/unchanged or queues until edit completion |
| `DELETE /api/mog/leaderboard/me` | Remove only caller's entry in the specified cohort |

Use the existing error envelope: `{ error: { code, message }, request_id }`. Include current revision when resolving a stale write. Distinguish invalid input (400), unauthenticated (401), unauthorized (403), absent/expired resource (404 or 410), state conflict (409), request limit (429), and temporary inference/service failure (503).

Mutations that create resources take an `Idempotency-Key`. Store a request fingerprint; reusing a key with different input is a conflict, not a silent replay.

### Space proxy implementation

Create allowlisted routes using Hono's `/:param` syntax. Do not expose a general URL-forwarding endpoint. Forward only required content type, session, idempotency, and request metadata; retain bounded body sizes and deadlines. Preserve backend status codes, binary media responses, and cookies. Do not let the current JSON-only proxy turn a photo into text.

Use a small fixed set of route families rather than a new route per match. Space route code must be changed through Space tools, not by trying to edit a fictitious workspace route file.

## 10. Shared leaderboard behavior

### Keep local and shared modes distinct

Add **Shared** and **This device** tabs to the leaderboard. Shared is the new default network view. This device preserves existing entries, IndexedDB photos, local deletion, and the current two-person local edit selector.

Existing records are user-editable browser data and may use the upstream 2.3–3.9 display conversion. They must not be uploaded as authoritative shared scores. Keep them visible locally; sharing requires a fresh server-registered scan. Do not silently erase or reinterpret old results.

### Submission and ranking

- A completed solo result offers “Save to shared leaderboard.”
- A match result offers the same action after the shared edit; an earlier choice to save is queued until edit completion.
- The request sends a result ID and replacement confirmation, not a numeric score.
- One best entry exists per player and cohort. Equal/lower scores leave the existing best unchanged. A higher score shows old/new values and asks for confirmation, preserving current replacement behavior.
- Names do not determine uniqueness or replacement rights.
- Sort by score descending, then earliest achievement time, then immutable entry ID for stable ties.
- Use competition ranks for equal scores (for example, 1, 1, 3); do not imply that a timestamp makes one tied score higher.
- Preserve the achievement time when an equal score is rejected; otherwise resubmission could reorder ties.
- Use cursor pagination, initially 50 rows per page, and return the caller's row/rank separately if outside that page.
- Keep live and upload results in separate labeled cohorts. Both existing solo paths remain supported, but a one-frame upload is not silently mixed into the live three-frame ranking.
- Public rows include display name, score, tier, rank, and date. Match photos are not public leaderboard assets.

When a match completes, pending publications are applied transactionally and exactly once. Publish no result from an uncommitted or cancelled match. After playback commitment, disconnecting one browser does not prevent a valid completed result from being published.

## 11. Frontend module changes

These are planned changes, not files created by this specification.

| Module/path | Change |
| --- | --- |
| `file 'Projects/ef/src/main.tsx'` | Add solo/match context and entry actions; reuse camera pipeline; separate solo-result versus match-locked completion; keep existing camera cleanup |
| `file 'Projects/ef/src/components/MogEdit.tsx'` | Preserve local selector mode; extract reusable player presentation; shared mode receives fixed participants and disables swap/arbitrary restart |
| `file 'Projects/ef/src/mogTimeline.ts'` | Export immutable timeline version/milestones; separate scene scheduling from determining a winner; shared mode uses server outcome |
| `file 'Projects/ef/src/editAudio.ts'` | Separate loading/decoding from future scheduling; support late-start offsets, mute, cancellation, and cleanup |
| `file 'Projects/ef/src/leaderboard.ts'` | Preserve local adapter and validation; do not turn local records into network writes |
| `file 'Projects/ef/src/leaderboardPhotos.ts'` | Preserve local photos and local edit behavior |
| `file 'Projects/ef/src/api/client.ts'` | Typed JSON/media requests, credentials, idempotency keys, bounded retry, error normalization |
| `file 'Projects/ef/src/multiplayer/types.ts'` | Match, participant, scan acknowledgment, playback snapshot, and leaderboard contracts |
| `file 'Projects/ef/src/multiplayer/useMatch.ts'` | Match state, polling, readiness, revision handling, reconnection, and generation cancellation |
| `file 'Projects/ef/src/multiplayer/useServerClock.ts'` | Clock sampling and stable monotonic server-time estimate |
| `file 'Projects/ef/src/components/MatchLobby.tsx'` | Create/join code UI, participant progress, readiness, recovery, and leave actions |
| `file 'Projects/ef/src/components/MatchReveal.tsx'` | Asset preparation and scheduled shared playback using the extracted edit presentation |
| `file 'Projects/ef/src/components/SharedLeaderboard.tsx'` | Cohort filters, pagination, current-player highlight, submission/replacement, and removal |
| `file 'Projects/ef/src/styles.css'` | Reuse current modal/edit styles; add responsive lobby, code input, countdown, and connection status |

Avoid reorganizing the whole application. Extract only the components/services needed to share playback and isolate multiplayer state. Match navigation must never leave an active camera, tracker, request loop, audio source, or object URL behind.

No top-level deep-link routing is required for invite codes. Match restoration comes from the server session, avoiding special query forwarding through the homepage iframe.

## 12. Backend module changes

| Module/path | Change |
| --- | --- |
| `file 'Projects/ef/service/app/main.py'` | Register new routers, initialize schema/scan registry, start and stop maintenance; retain existing scoring route |
| `file 'Projects/ef/service/app/config.py'` | Add database/media paths, TTLs, clock/scheduling settings, session settings, and per-operation limits |
| `file 'Projects/ef/service/app/db.py'` | Connections, migrations, transactions, backup hooks |
| `file 'Projects/ef/service/app/sessions.py'` | Guest sessions, cookie issuance, token hashing, identity dependencies |
| `file 'Projects/ef/service/app/matches.py'` | Invite creation/joining, ownership, state transitions, snapshots, readiness, revisions |
| `file 'Projects/ef/service/app/playback.py'` | Candidate runs, acknowledgments, commit deadlines, start/completion reconciliation, replay generations |
| `file 'Projects/ef/service/app/scans.py'` | Owned registered scans, frame idempotency, inference reuse, server aggregation, result persistence |
| `file 'Projects/ef/service/app/display_score.py'` | Live display conversion and tier boundaries with explicit version and rounding |
| `file 'Projects/ef/service/app/media.py'` | One selected crop per match participant, atomic file writes, authenticated retrieval, expiry |
| `file 'Projects/ef/service/app/leaderboard.py'` | Cohort ranking, ownership, best-score replacement, pending publication, removal |
| `file 'Projects/ef/service/app/maintenance.py'` | Expiry, state reconciliation, orphan cleanup, and consistent backups |

Reuse existing inference, error, concurrency, and restricted logging helpers. Extract a shared inference service if needed rather than calling the HTTP scoring endpoint from inside another FastAPI handler.

Run maintenance as a bounded asynchronous lifecycle task in the existing managed process, not a separate Zo chat automation. Reconcile due transitions every 250 ms while countdowns are active, less frequently when idle, and also when serving match requests. Clean up media/expired sessions on a slower interval. On restart, load durable runs and reconcile by timestamps before returning state.

## 13. Failure handling

| Situation | Required behavior |
| --- | --- |
| Invalid/expired/full invite | Clear join error; no participant details disclosed |
| Two simultaneous joiners | Exactly one gets B; other receives match-full conflict |
| Camera denied or quality timeout | Existing scanner recovery; opponent remains in lobby |
| Duplicate frame request | Same acknowledgment/result; no extra scoring contribution |
| Scoring process restarts mid-scan | Incomplete scan invalidated; rescan required; completed opponent result preserved |
| Model changes mid-match | Explain version change and offer new match; do not compare mixed models |
| One device cannot load photo/audio | Stay in preparation; retry asset load or explicitly continue muted for audio-only failure |
| Device leaves before commitment | Candidate cancelled or not created; other sees waiting/disconnected |
| Device disconnects after commitment | Run continues; reconnect seeks to correct point |
| Old poll finishes after newer poll | Ignore its lower revision/generation |
| Photos expire | Completed scores still display; explain that photo replay expired |
| Save request times out | Idempotent retry; never create duplicate leaderboard entries |
| Database write fails | Return retryable error; never show successful save only in local state |
| Server restart during countdown | Reconcile the durable candidate/commit; do not invent a second start time |
| Guest cookie is lost | Existing server results remain; do not let the display name recover ownership |

## 14. Verification plan

### Backend tests

Use temporary SQLite databases, a controllable clock, and the existing mock inference runner. Use synthetic images only.

- Invite generation, normalization, expiry, collisions, and race-safe joining.
- Session ownership and inability to occupy both slots or access another match's media.
- Match-scan redaction before commitment, including errors and diagnostics.
- Three-frame median, one-frame solo upload, exact JS-compatible rounding, tier boundaries, and model/display-map mismatch.
- In-flight duplicate frames, request retries, stale revisions, and resource idempotency.
- Candidate creation, missing acknowledgments, deadline cancellation, committed start, completion, and synchronized replay.
- Restart during waiting, preparation, countdown, and completed playback.
- Score 0 and 100, ties, stable ranks, higher-score confirmation, and lower-score preservation.
- Leaderboard publication delayed until edit completion and applied once across replay/restart.
- Match-media expiry, file/database consistency, orphan cleanup, and SQLite backup restore.

### Frontend unit tests

Add Vitest in the project workspace, not in the managed Space package.

- Scene boundaries at 3.6, 7.2, 8.1, 10.8, 11.7, 14.4, and 15.4 seconds.
- Clock-offset estimation under delayed responses and mismatched device wall clocks.
- Candidate-versus-committed playback behavior and ignored stale generations.
- Audio scheduling and seeking with a fake audio context.
- Local/shared leaderboard separation and no automatic legacy uploads.
- Match completion never mounts the normal solo score panel.

### Browser and device tests

Use two independent Playwright browser contexts to represent separate guests. Test-only fixtures may simulate scanner completion and media; no score override or test endpoint ships in the public bundle.

Then run actual two-device camera/audio tests, including mobile Safari and Chrome:

1. Create and enter a code.
2. Complete scans in both possible orders.
3. Ready one device significantly before the other.
4. Confirm that both photos and audio are loaded before countdown.
5. Measure start, stamp, and reveal skew over at least 20 runs on stable Wi-Fi.
6. Repeat on different networks, with artificial latency, a late refresh, and background/foreground transitions.
7. Verify user-gesture audio startup and muted fallback on iOS.
8. Verify no overflow at 320 px and 390 px widths; preserve reduced-motion behavior.
9. Verify shared results survive refresh and service restart and are visible from a third browser.
10. Recheck solo scanning, uploads, PNG cards, local leaderboard saves/deletes, local edit swap, replay, and camera cleanup.

## 15. Implementation order and checkpoints

### A. Reconcile the baseline

Merge the pinned upstream commit into the live integration branch. Resolve scanner conflicts explicitly, preserving the live score mapping and fail-closed behavior. Confirm local leaderboard and local edit work without multiplayer. Do not deploy an intermediate merge that restores random scores.

### B. Add persistence and authoritative scans

Implement migrations, sessions, registered scans, server display conversion, result records, and media storage. Preserve legacy scoring compatibility. Complete database/scoring tests before building the lobby.

### C. Implement invite-code matches

Add create/join/restore/leave, atomic slot claiming, participant statuses, owned match scanning, and the lobby UI. At this checkpoint, two browsers must finish distinct scans and recover the same match after refresh; no synchronized edit is required yet.

### D. Extract and synchronize the reveal

Separate edit presentation/audio from the local selector. Implement clocks, preloading, readiness, scheduling acknowledgments, committed snapshots, seeking, and replay. Preserve existing animation/music instead of generating a replacement video.

### E. Connect the shared leaderboard

Add cohort-aware reads, owned result submissions, best-score replacement, deterministic ties, pagination, current-player placement, delayed match publication, and removal. Keep This device mode intact.

### F. Test and deploy together

- Run the client production build and all new unit/browser tests.
- Run existing and new pytest suites with the mock model.
- Exercise the existing private scoring service after backend deployment.
- Back up any database before migrations.
- Restart the existing managed process for backend changes; do not manually start a duplicate service.
- Add/update Space API proxies and verify cookies, registered scans, media bytes, status codes, and origin checks through the public hostname.
- Build with `VITE_SCORE_ENDPOINT=/api/ef-score` and Vite base `/mog-scan/`; configure the new client API base as `/api/mog`.
- Upload all new hashed assets first, including bundled music and stamp, then replace `/mog-scan/index.html` last.
- Update the homepage iframe permission additively without replacing the homepage design.
- Run a final two-device test at https://mog.zo.space/.

Old tabs must continue to use legacy solo scoring during rollout. If a match requires a newer timeline/asset version than a client supports, instruct that client to reload before readying rather than playing an incompatible edit.

Keep the previous built HTML/assets for frontend rollback. Database changes should remain backward-compatible during the deployment window; disable new multiplayer UI on rollback rather than deleting collected records. Restore a database backup only as an explicit data-recovery action, not an automatic part of frontend rollback.

## 16. Definition of done

- A creates a code and B joins it from another device without a link or account signup.
- Only two distinct guest players can occupy the match.
- Each completes a fresh live scan; scores stay out of the ordinary UI until the shared edit.
- Both devices play the existing photo-based reveal with identical A/B order, outcome, soundtrack position, and timeline version.
- Readiness/preloading prevents one slow-loading device from causing an immediate unilateral start.
- Refresh and reconnect preserve the match and seek committed playback correctly.
- Shared leaderboard results persist on the server, use verified server scores, and cannot be replaced by another person reusing a display name.
- Local records and the original local edit continue to work.
- The new functionality is verified through the actual same-origin Space proxies, not only a localhost test server.
- No generated MP4 pipeline, full account system, or hosting migration has been introduced unnecessarily.

## Source references

The plan is based on direct inspection of these pinned upstream sources and the existing live proxy/local integration. Proposed behavior above is distinguished from what exists today.

- [Upstream baseline commit](https://github.com/brandontautuan/ef/commit/dfd305e108f4890274b488d6134f28fa440d70f1).
- [Client README](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/README.md).
- [Current upstream scanner and local integration points](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/src/main.tsx).
- [Existing edit player](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/src/components/MogEdit.tsx).
- [Existing edit audio](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/src/editAudio.ts).
- [Existing scene timeline](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/src/mogTimeline.ts).
- [Local leaderboard implementation](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/src/leaderboard.ts).
- [Local photo store](https://raw.githubusercontent.com/brandontautuan/ef/dfd305e108f4890274b488d6134f28fa440d70f1/src/leaderboardPhotos.ts).
