# Mog Scan — Remaining Implementation Scope

**Purpose:** Close the gap between the current demo and the intended live-analysis and model-scoring MVP.

## Current baseline

The browser already opens the front camera, runs MediaPipe Face Landmarker, blocks zero/multiple faces, checks face size/cutoff/basic roll, captures selected square crops, and aggregates three responses. The API already validates and preprocesses crops safely, but its only runner is a deterministic mock. The current on-screen guide is static rather than landmark-aligned.

## Work packages

| ID | Work package | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| P0 | Align the score configuration | Both | None | Client, service calibration file, and service model version use the same eight tiers and score map. |
| P1 | Finish live quality analysis | Client | P2 for final thresholds | The gate reliably evaluates pose, light, blur, motion, framing, and one face. |
| P2 | Tune/validate quality thresholds | Both | P1 | Thresholds are selected from consenting device-test recordings and documented as config. |
| P3 | Render the live landmark effect | Client | P1 | The 478-landmark data drives a responsive mesh/outline aligned to the face. |
| P4 | Select, license, and package a real rating model | ML/backend | Legal/model review | A reproducible, permitted model package returns a native score for a crop. |
| P5 | Calibrate score scale and tier distribution | ML/backend + product | P4 | Display mapping and tier targets are empirically reviewed and versioned. |
| P6 | Integrate, test, and harden end-to-end | Both | P0–P5 | Real service works on supported devices, including all key failures and privacy checks. |

## P0 — Score-configuration alignment

**Why first:** The client now labels `0–100` with the eight requested tiers, while `service/models/mock-ui-v1/calibration.json` still declares an older four-tier placeholder. A real integration should never have two sources of truth.

**Implement**

- Make the service calibration artifact the versioned source of truth, then load or publish it to the client at build/deploy time.
- Replace the placeholder service tiers with: `TRUE ADAM` 99–100, `ADAM` 95–98, `CHAD` 88–94, `CHADLITE` 80–87, `HTN` 70–79, `MTN` 60–69, `LTN` 50–59, `SUB5` 0–49.
- Include the specified target shares as metadata only: 0.05%, 0.45%, 1.5%, 3%, 15%, 35%, 30%, and 15%.
- Reject a client/service model-version mismatch, and retain the returned version with the scan result.

**Acceptance criteria**

- One fixture maps every boundary score correctly: 0, 49, 50, 59, 60, 69, 70, 79, 80, 87, 88, 94, 95, 98, 99, and 100.
- No client code or deployed calibration file contains a competing tier table.
- Target shares are never presented as an individual’s percentile.

## P1 — Live quality analysis

### 1. Pose: yaw, pitch, roll

**Current:** Roll is estimated from two eye landmarks. Yaw and pitch are absent.

**Implement:** Preserve `x`, `y`, and `z` landmark values. Estimate a stable head transform using MediaPipe facial transformation matrices if available, or a documented landmark-based pose solver. Smooth values across a short frame window. Compare absolute yaw/pitch/roll to configurable limits and use `Face forward` when the first pose check fails.

**Acceptance criteria:** Known left/right/up/down/tilted recordings correctly fail the relevant configured threshold; noisy single-frame changes do not flip the prompt.

### 2. Lighting

**Current:** Prompt copy exists but no measurement.

**Implement:** Sample luminance and contrast inside the selected face region, not the whole preview. Use downsampled pixels to keep the operation cheap. Gate very dark, clipped, or low-contrast frames and tune thresholds separately for major device camera pipelines.

**Acceptance criteria:** Dark and heavily backlit fixtures fail; normal indoor/window lighting passes; the measurement runs without visibly reducing preview responsiveness.

### 3. Blur and motion

**Current:** Prompt copy exists but no measurement.

**Implement:** Calculate a cheap sharpness measure (for example, variance of a Laplacian) on the face crop. Compare current and prior face-frame transforms/landmarks for motion. Require the entire quality gate to remain valid for a short hold interval before selecting a frame; retain the existing brief failure grace interval.

**Acceptance criteria:** Deliberately shaken/defocused test frames fail; a stationary, sharp face qualifies; a blink or one tracker miss does not reset progress.

### 4. Framing and reliability

**Current:** One-face, minimum-size, cutoff checks exist.

**Implement:** Add detector confidence/reliability handling, face-center tolerance, and a maximum-size threshold. Define a deterministic prompt priority: no/multiple face → framing → pose → light → motion/blur.

**Acceptance criteria:** Only one prompt is shown at a time, and the same input produces the same reason/prompt.

## P3 — Landmark-aligned live effect

**Implement**

- Enable the Face Landmarker outputs needed for the chosen visual effect; enable blendshapes only if an effect actually uses them.
- Create a canvas/WebGL overlay sized to the *rendered* video rectangle, accounting for `object-fit: cover`, mirroring, orientation, and device pixel ratio.
- Draw either a lightweight contour/feature-line treatment or a decimated mesh. Do not blindly draw every connection at full resolution on slower phones.
- Smooth landmarks visually without making the overlay noticeably lag behind the face.
- Reduce render cadence/detail when frame time exceeds the performance budget; keep quality gating independent of the decorative effect.

**Acceptance criteria**

- Overlay follows face movement and mirrored preview accurately on current Safari mobile, Chrome mobile, and desktop Chromium.
- No major canvas/landmark buffer is retained after exit/rescan.
- Preview/tracking remains responsive on the agreed midrange device baseline.

## P4 — Real attractiveness-regression runner

**This is the launch-critical work package.** Do not replace the mock merely with public weights of unclear provenance.

**Implement**

1. Select a candidate model whose code, weights, and training data/labels each have documented permitted use for the intended launch.
2. Write a model card: model source, training population and rating process, native range, input transform, limitations, intended use, and approval record.
3. Package weights, preprocessing specification, output range, checksums, and `model_version` together in an immutable model directory.
4. Implement a non-mock `ModelRunner` in `service/app/inference/model.py` that consumes the existing `preprocess-v1` output (or versions preprocessing if the model requires a different transform).
5. Add reproducible golden-image tests and a startup/readiness check that fails safely when weights are absent or invalid.
6. Keep images in memory only; do not add score/image storage for model debugging.

**Acceptance criteria**

- Service starts only with a valid manifest and verified model artifact.
- Identical valid fixtures return stable finite native scores in the manifest range.
- Tests prove an unavailable/bad model returns a safe `503`, never a fabricated score.
- Rights review and model-validation sign-off are recorded before public exposure.

## P5 — Calibration and tier distribution

**Implement**

- Collect an appropriately consented evaluation set; do not use production user scans without distinct consent.
- Measure repeatability: multiple scans per participant across reasonable lighting, pose, and expression variation.
- Inspect native-score distribution, error rates, and subgroup behavior appropriate to the intended population. Do not claim fairness from an inadequate sample.
- Pick the `native → 0–100` transform and review whether it produces the requested tier shares on the evaluation set.
- Version the result in the model manifest/calibration artifact, with a changelog for each revised model or transform.

**Acceptance criteria**

- A report states sample provenance/consent, repeat-scan variation, latency, distribution, and known limitations.
- Tier shares are measured against the agreed evaluation definition; they are never described as percentile rankings in the UI.
- Client and service use the same immutable calibration version.

## P6 — End-to-end integration and release checks

**Implement**

- Point `VITE_SCORE_ENDPOINT` at staging, configure exact CORS origins, HTTPS, service rate limits, and request deadlines.
- Add contract tests for success, malformed/oversize image, unsupported type, timeout, `429`, `503`, stale response, rescan, and changed model version.
- Run a device matrix: current Chrome Android, current Safari iOS, and desktop Chromium. Cover permission denied, one/no/multiple faces, low light, motion, blur, backgrounding, camera switch, service outage, and share cards.
- Verify network/logs/storage: only eligible selected frames travel to the service; no image bytes, landmarks, embeddings, or score history persist.
- Pin MediaPipe model/WASM asset versions and serve or integrity-control them for production instead of relying on `latest` URLs.

**Acceptance criteria**

- A cooperative user gets a locked result after three valid real-model samples on supported test devices.
- No failed condition yields a fabricated score or retains active camera tracks after exit.
- Launch checklist approves model rights, privacy checks, repeatability, and device/latency test results.

## Recommended sequence

1. Do P0 immediately; it is a small integration mismatch.
2. Client implements P1 and P3 in parallel with backend/ML P4.
3. Both tune P2 after the quality signals exist.
4. Backend/ML completes P5 only after P4 and a consented evaluation set are ready.
5. Both complete P6 against staging; public launch is blocked until P4, P5, and P6 pass.

## Ownership split

- **Client owner:** P1, P3, the client half of P0/P2/P6.
- **ML/backend owner:** P4, P5, service half of P0/P6.
- **Joint product decision:** tier calibration review, prompt thresholds, model/rights launch gate, and release sign-off.
