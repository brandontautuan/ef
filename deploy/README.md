# Deploying the shared/social features

The app code for anonymous sessions, registered scans, the shared leaderboard,
and the social system (mogs, votes, feeds) lives in this repo. Two pieces live
in Zo Space and have to be changed there with the Space route tools; they are
**not** implemented by files in this repo.

## 1. Space API proxies (allowlisted, same origin)

Proxy each public route to the private FastAPI service on `127.0.0.1:8767`.
Use Hono `/:param` syntax. Declare the fixed `head` and `state` paths before
`/posts/:id`.

| Public route | Methods | Backend route |
| --- | --- | --- |
| `/api/mog/session` | GET, POST | `/v1/session` |
| `/api/mog/scans` | POST | `/v1/scans` |
| `/api/mog/scans/:id/frames` | POST (multipart) | `/v1/scans/:id/frames` |
| `/api/mog/leaderboard` | GET, POST | `/v1/leaderboard` |
| `/api/mog/leaderboard/me` | DELETE | `/v1/leaderboard/me` |
| `/api/mog/posts` | GET, POST | `/v1/social/posts` |
| `/api/mog/posts/head` | GET | `/v1/social/posts/head` |
| `/api/mog/posts/state` | POST | `/v1/social/posts/state` |
| `/api/mog/posts/:id` | GET, DELETE | `/v1/social/posts/:id` |
| `/api/mog/posts/:id/vote` | PUT | `/v1/social/posts/:id/vote` |
| `/api/mog/posts/:id/media` | GET (binary) | `/v1/social/posts/:id/media` |
| `/api/mog/me/posts` | GET | `/v1/social/me/posts` |
| `/api/mog/me/upmogs` | GET | `/v1/social/me/upmogs` |
| `/api/mog/me/shareable-results` | GET | `/v1/social/me/shareable-results` |

Each proxy must:

- Forward `Cookie`, `Content-Type`, `Accept`, `Idempotency-Key`, `Origin`, and
  `Sec-Fetch-Site`, plus the query string. Keep bounded body sizes and deadlines.
- Return the backend status code, body, `Set-Cookie`, `Retry-After`, and
  `Cache-Control` unchanged. Don't turn binary media into text.
- Reject mutation requests whose `Origin` isn't exactly `https://mog.zo.space`.
  The backend checks this too, and also requires the session.
- Never cache these responses (the backend sends `Cache-Control: private, no-store`).
- If the proxy overwrites a client-address header, set `TRUSTED_CLIENT_IP_HEADER`
  to its name on the service. Otherwise leave it unset.

`vite.config.ts` has the same mapping (`rewriteMogApiPath`) for local
development, so behavior matches.

## 2. Homepage route bridge

Add `deploy/homepage-route-bridge.js` to the homepage after the iframe that
embeds `/mog-scan/index.html`. It syncs `https://mog.zo.space/#/mogs/<id>`
style URLs with the app inside the iframe (direct links, Back/Forward).
Also add `autoplay` to the iframe's existing `allow` list if not present.
Nothing else on the homepage changes.

## 3. Build and rollout order

1. Back up the database: `python -m app.manage backup data/backups/pre-social.sqlite3`.
2. Deploy the backend and restart the existing managed service (don't start a
   duplicate). Migrations run automatically at startup and are additive.
   Set `DISPLAY_MAP=linear-1-5-v1` on the deployed site if it keeps the native
   1-5 display map (see the 1v1 plan). Keep `SESSION_COOKIE_SECURE` at its default.
3. Add or update the Space proxies above and check them through the public
   hostname: cookie round-trip, PUT and DELETE forwarding, cache headers.
4. Build the client with the `/mog-scan/` base plus:

   ```sh
   VITE_MOG_API_BASE=/api/mog VITE_PUBLIC_APP_URL=https://mog.zo.space/ \
   VITE_SCORE_ENDPOINT=/api/ef-score npm run build -- --base=/mog-scan/
   ```

5. Upload the new hashed assets first, then replace `/mog-scan/index.html` last.
   Keep the previous HTML/assets for rollback. To roll back, disable the social
   UI by building without `VITE_MOG_API_BASE`. Don't delete stored social data.

## Operations

```sh
cd service
python -m app.manage backup data/backups/mog-$(date +%Y%m%d).sqlite3
python -m app.manage reconcile-votes   # recompute counters from vote rows
python -m app.manage cleanup-media     # also runs automatically every 5 minutes
```

Include `service/data/post-media` in backups if post photos are ever enabled.
