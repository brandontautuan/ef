# Contributor and agent guide

## What this repository is

Mog Scan is a mobile-first live-camera prototype. The browser tracks a face,
guides framing, selects usable crops, and combines three scoring responses into
a score out of 100 and a tier. Users can download a locally rendered result card,
with or without their face. Scores are presented as entertainment-oriented model
estimates, not objective measures of attractiveness or personal worth.

This repository contains a React/TypeScript client and a separate Python/FastAPI
service. There is no database, account system, or persistent scan history.
The default scoring paths are mocks; a working demo is not a validated rating
product.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/main.tsx` | Client entry point and the entire React app: scan state, camera/tracker lifecycle, quality gate, cropping, API calls, aggregation, result UI, and card export. |
| `src/styles.css` | Responsive layout, camera overlay, scan animation, and result styling. |
| `src/components/BlackCapsule.tsx` | Shared decorative capsule and 28 deterministic CSS particle trajectories for the start animation. |
| `src/resultCopy.ts` | Tier-specific roast headlines and descriptions; also used in exported cards. |
| `index.html`, `vite.config.ts`, `tsconfig*.json` | Browser entry, Vite setup, and strict TypeScript configuration. |
| `service/app/main.py` | FastAPI startup, `/health`, `/v1/calibration`, and `/v1/score`; request validation and inference orchestration. |
| `service/app/inference/` | Manifest loading, image decoding/preprocessing, deterministic mock, and optional SCUT research runner. |
| `service/app/config.py`, `service/.env.example` | Environment settings for model selection, payload limits, deadlines, concurrency, rate limiting, and CORS. |
| `service/app/concurrency.py`, `rate_limit.py`, `errors.py`, `logging_utils.py` | Service admission control, rate limits, stable errors, and restricted request logging. These files all live under `service/app/`. |
| `service/models/` | Versioned model manifests and display-calibration artifacts. Research weights are not checked in. |
| `service/tests/` | Pytest coverage for API responses, mock determinism, calibration metadata, rate limiting, and logging. |
| `Mog_Scan_*.md` | Product intent, client/service design, and proposed remaining work. Some descriptions lag behind the code. |

## How a scan works

1. The user starts a scan, which requests the front camera. MediaPipe Face
   Landmarker runs in the browser and supplies landmarks, not rating scores.
2. The client checks one-face presence, size, crop boundaries, pose, brightness,
   sharpness, and motion using heuristics. It draws a live landmark overlay and
   provides corrective prompts.
3. After a quality hold, the client captures a 640 × 640 face-centered crop and
   encodes it as JPEG. Sampling runs about every 1.1 seconds, with at most one
   scoring request in flight per scan.
4. With `VITE_SCORE_ENDPOINT` set, `scoreFrame` posts multipart fields `image`,
   `scan_id`, and `frame_sequence`. The service decodes, resizes, normalizes, and
   scores the crop according to its active model manifest.
5. The service returns `native_score`, `model_version`, and `request_id`. The
   client collects three predictions, rejects mixed model versions, takes their
   median, then applies its display conversion and tier thresholds.
6. The result and optional PNG card are rendered locally. Card export is a user
   action; no social-posting integration exists.

The client states are `idle`, `permission`, `acquiring`, `sampling`, `paused`,
`result`, and `error`. Read `startCamera`, `assessFrame`, `captureFrame`, `sample`,
and `finish` in that order to follow the main path through `src/main.tsx`.

## Local development

Run the client from the repository root:

```sh
npm ci
npm run dev
```

Without `VITE_SCORE_ENDPOINT`, the client returns random development scores
labeled `mock-ui-v1`. No scoring API is needed, but the camera flow still loads
MediaPipe runtime assets from external URLs.

To run the API, use a separate terminal from the repository root:

```sh
cd service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

Then start (or restart) the client from the repository root:

```sh
VITE_SCORE_ENDPOINT=http://localhost:8000/v1/score npm run dev
```

The endpoint must include `/v1/score`. Add `VITE_SCAN_DEBUG=1` for browser console
diagnostics and result calculation details. Vite defaults to port 5173; the API
allows origins `http://localhost:5173` and `http://localhost:5174` by default.

The API defaults to `service/models/mock-ui-v1`, whose runner deterministically
hashes the preprocessed image into a score. Connecting the API does not enable a
real rating model. Its version string differs from the browser-only mock.

Service settings are read from the process environment; `.env.example` is a
reference, and the application does not itself load a `.env` file. Client
`VITE_*` values are browser-visible configuration, so never put secrets there.
Camera use on deployed origins requires a secure context; use HTTPS for device
testing outside localhost.

## Validation

- Client changes: run `npm run build` from the repository root. This performs
  TypeScript checking and produces the Vite build. There is currently no client
  test runner or lint script in `package.json`.
- Service changes: activate `service/.venv`, then run `python -m pytest` from
  `service/`. Keep the default mock model active for the existing tests.
- Camera or lifecycle changes: manually check permission denial, no/multiple
  faces, quality failure and recovery, timeout, backgrounding, retry, rescan,
  exit, and card export with and without a face. Verify camera tracks, timers,
  and stale asynchronous responses across those transitions.
- Contract changes: update both client and service, relevant service tests, and
  documentation. Preserve response field names and stable error envelopes.
- Documentation-only changes: check paths and commands against the code; a full
  dependency installation or camera session is unnecessary.

Report what was actually verified and any checks that could not be run.

## Contribution boundaries

- Keep camera permission tied to an explicit start action. Upload only selected
  crops after the quality gate; do not add continuous-video uploads.
- Preserve the design's no-persistence boundary for scan images and derived
  data. Do not add image bodies, landmarks, embeddings, or identifying score
  records to logs, analytics, storage, or test fixtures. Use synthetic images in
  service tests and the existing restricted request-logging helper.
- Treat privacy statements as requirements to verify through the whole request
  stack, not proof that framework upload handling or infrastructure is safe.
- Keep score presentation separate from inference. General style copy must not
  claim that a facial feature caused a score or provide model-derived diagnoses.
- Model weights, preprocessing, native range, and calibration are versioned
  together. Changes require a new model version; calibration `modelVersion`
  must match the manifest.
- The SCUT package is explicitly marked private research only in this repo.
  Do not enable it for public deployment. Public launch requires a permitted,
  reviewed model and validated calibration, as described in the design docs.
- Match the existing React hooks/TypeScript and Python module conventions. Keep
  changes focused; do not reorganize the whole app as part of an unrelated fix.
- Keep generated output, environments, image captures, and model weights out of
  commits. Preserve `package-lock.json` when changing npm dependencies.

## Current gaps and good starting points

1. **Score configuration:** The service exposes `/v1/calibration`, but the client
   does not consume it. The client maps native scores from 2.3–3.9 to 0–100,
   while the service artifacts declare 1–5 and different tier boundaries. This
   is an integration gap, not a reviewed calibration.
2. **Client structure and coverage:** Most behavior lives in one component.
   Focused extraction of score conversion, quality analysis, or API handling
   can make the associated behavior easier to test when working in those areas.
3. **Device and lifecycle validation:** Quality thresholds are heuristic. Check
   actual camera behavior and resource cleanup, including result/error states
   and background recovery; UI labels alone do not establish camera state.
4. **Production readiness:** MediaPipe runtime URLs currently use `latest`.
   Pin/audit assets, validate CORS and service limits, and complete model and
   calibration review before treating this as launch-ready.
5. **Scan notes:** The advice scope proposes tips based on observed scan-quality
   history. Current result copy uses static tier playbooks; it does not implement
   that proposed scan-history summary.

Start with [README.md](README.md) and [service/README.md](service/README.md), then
read [the MVP overview](Mog_Scan_MVP_Design_Doc.md). For work in a specific area,
use [the client design](Mog_Scan_Client_Design_Doc.md),
[the service design](Mog_Scan_Service_Design_Doc.md), or
[the advice scope](Mog_Scan_Advice_System_Scope.md).
[The remaining-work document](Mog_Scan_Remaining_Implementation_Scope.md) is a
planning reference, not an exact status report: the code already includes pose,
light, blur/motion heuristics, a landmark overlay, eight-tier service artifacts,
and a research runner that some of its baseline text describes as absent.

## Session handoff — September 26, 2026

### Local model setup

- The SCUT research checkpoint has been downloaded to
  `service/models/scut-prototype-v1/beauty_regressor.pt` and verified against the
  publisher's SHA-256. It and `service/.venv` are git-ignored local artifacts;
  a fresh checkout will need both installed again. Provenance, pinned revision,
  checksum, and installation instructions are in `service/README.md`.
- From the root, `sh service/start-research.sh` starts the research API on
  `127.0.0.1:8000`. It reports model version
  `scut-prototype@local-research-v1+imagenet-preprocess-v1` at `/health`.
- Root `.env.development.local` points Vite to
  `http://localhost:8000/v1/score`. It is ignored and applies only to development.
  Run `npm run dev`, and open `http://localhost:5173` (the configured CORS origin).
  Do not assume servers survive between sessions; check before starting duplicates.
- The model loaded successfully and returned repeatable predictions for a
  synthetic drawn face. All 15 service tests passed with the default mock.
  Non-face synthetic inputs produced out-of-range predictions and were rejected
  with 503 by the existing API range check. This is not live-face validation.
- Research-only status and unvalidated display calibration still apply. The
  frontend redesign did not change scoring, native range, or tier boundaries.

### Frontend direction and behavior

- The user wants a dark “black-pill” aesthetic: matte black, chrome capsule,
  off-white condensed typography, fine borders, restrained red highlights, and
  irreverent score roasts. Keep the tone playful and aim roasts at the scan;
  do not add self-harm instructions, fatalistic life advice, or claims about worth.
- Scores display as `x/100` in the result and PNG export. The `SUB5` label is the
  existing lowest tier (display score below 27), not a newly introduced `<50`
  threshold. Its roast is “Delete the evidence.” No score boundaries were changed.
- Starting/retrying a scan runs a two-second decorative capsule-opening overlay.
  The halves separate and 28 miniature capsules spill downward. Camera permission
  starts concurrently from the user's click; animation must not delay it, alter
  captured pixels, or block the End scan control. Exit cancels the overlay; retries
  replay it. Reduced-motion preferences suppress the spill and shorten transitions.
- Cards use the same dark styling and roast headline, support the face-free option,
  and include the denominator. Result UI retains the entertainment disclaimer and
  optional general style suggestions; these do not explain model predictions.
- Result/error/idle states now stop camera tracks and tracking. Startup timeouts
  are tracked, and cancelled sessions discard late permission/tracker completions.
  Continue testing lifecycle behavior when changing scan orchestration.
- Build and visual checks are the available frontend verification workflow. For
  checking result layouts without taking a photo, use a temporary ignored fixture
  under `.vite/`; do not ship score overrides or mock controls in the real app.
- Verified this redesign with `npm run build`, desktop landing/start-animation
  checks, cancellation back to idle, result fixtures at 390px and 320px (including
  `100/100` without horizontal overflow), and a generated face-free card preview.
  The temporary fixtures were removed. Real-camera inference, permission-denial
  recovery, and reduced-motion behavior still need device testing; CSS includes
  a reduced-motion fallback. No real person was scanned during these UI checks.
- Existing unrelated `package.json` changes add `allowScripts` entries for
  esbuild/fsevents. Preserve them; they were present before the model/frontend work.
