# Mog Scan MVP Design Document

**Status:** Working draft  
**Date:** September 2026  
**Platform:** Mobile-first web app, with desktop browser support

## 1. Product summary

Mog Scan is a playful live-camera app. A user opens the camera, sees a face-tracking overlay and real-time guidance, holds a usable pose for a few seconds, and receives a model-rated score, a tier, and an optional share card. The scan itself should be entertaining; the product should not feel like a static photo uploader with a delayed rating.

The score represents a particular model's prediction from a camera image. It is **not** an objective measure of attractiveness, a percentile among people, or a measure of personal worth. The app should use entertainment-oriented language while explaining what the model actually does.

**MVP goal:** Determine whether users complete a live scan, rescan, and voluntarily share a result. The first build should validate the camera experience and score stability before adding accounts or social features.

## 2. Target experience

### Core user journey

1. **Landing:** Show a short demonstration of the live scan, a `Start scan` button, and a concise note that the camera is used for the scan. Do not request camera access before the user starts.
2. **Permission:** Request the front-facing camera. If denied, explain how to enable it and offer a retry. Camera access requires a secure context in deployment.
3. **Acquire:** Mirror the preview for a natural selfie experience. Draw a tracking overlay aligned with the face. Give one actionable prompt at a time: `Move closer`, `Face forward`, `Find brighter light`, or `Hold steady`.
4. **Scan:** Once the quality gate passes, show a progress ring and sample selected frames. Keep tracking and effects responsive while the rating model works at a slower cadence.
5. **Reveal:** Animate to a stable score out of 100 and a playful tier. Show a brief note that the result is a model estimate from this scan. Allow `Scan again` immediately.
6. **Share:** On an explicit tap, freeze a selected frame and render a downloadable image card with the score, tier, and app branding. The user can choose a card without their face if desired.

### Suggested screen layout

- **Camera area:** Full-screen portrait preview on phones; centered portrait viewport on desktop. Overlay a subtle face outline or landmark effect without obscuring the person.
- **Top area:** App name, privacy link, and camera status.
- **Bottom area:** One current guidance prompt, progress indicator, and scan/retake action. Keep text clear of the face.
- **Result view:** Large score and tier, selected still, `Scan again`, and `Share result`. The camera should stop when the user exits the scan view.

The UI may feel energetic, but it must never show a rapidly oscillating numeric score during acquisition. The animation can react continuously to movement while the final score waits for valid samples.

## 3. MVP scope

### Included

- Front-facing live camera on supported mobile and desktop browsers.
- One-face detection and landmark tracking in the browser.
- A mirrored preview, face overlay, and live alignment/lighting guidance.
- Frame quality gate, scan progress, and a short countdown or hold period.
- Open-source rating model inference on selected frames.
- Aggregated, stable result with a score, tier, and rescan.
- Locally generated share card, including an option to omit the face.
- Clear permission, unsupported-browser, no-face, multiple-face, low-quality, timeout, and model-error states.
- Anonymous, non-image product metrics if analytics are enabled.

### Deferred

Accounts, profiles, public leaderboards, comparing or ranking other people, identity recognition, face search, persistent image history, automatic social posting, video recording, paid features, and personalized appearance advice. A photo upload fallback can be added after the live flow works well, but it is not the main experience.

## 4. Scan state machine

| State | Entry condition | UI and action | Exit condition |
| --- | --- | --- | --- |
| `idle` | Page loaded | Explain scan and show start action | User taps start |
| `permission` | Start requested | Request camera | Permission granted or denied |
| `acquiring` | Camera active | Track face and show one quality prompt | A single valid face is stable |
| `sampling` | Quality gate passes | Progress animation; collect model predictions | Enough valid predictions or quality fails |
| `paused` | Face lost or quality fails during sampling | Keep progress; explain correction | Quality recovers or timeout |
| `result` | Aggregation complete | Lock score and show tier/actions | Rescan or exit |
| `error` | Camera/model failure | Explain failure and show retry | Retry or exit |

A brief blink or momentary tracker miss should not reset the whole scan. Use a short grace period; pause after sustained quality failure. Clear an unfinished scan after a longer timeout so a person cannot accidentally combine unrelated camera sessions. Rescan starts a fresh sample buffer.

## 5. Live analysis and scoring

### Two processing loops

**Local tracking loop:** Run MediaPipe Face Landmarker in the browser on camera frames at a device-appropriate rate. Use its landmarks to position the overlay and estimate framing and head orientation. Keep expensive work off the main UI thread where supported. Lower tracking resolution or cadence on slower devices while preserving a responsive preview.

**Rating loop:** Approximately once per second, select a frame only if the quality gate passes. Crop and align the face using a documented preprocessing pipeline. Send the selected image over HTTPS to a small inference service for the first MVP. Do not stream the full video. Allow at most one outstanding rating request, attach a scan ID and frame sequence, and discard stale responses after a rescan or view change.

A browser-deployed rating model would reduce image transfer and hosting needs, but the model must first be tested for conversion, load time, memory use, and performance on ordinary phones. It is a later optimization, not a prerequisite for the first demo.

### Quality gate

Before rating a frame, check:

- Exactly one reliably detected face.
- Face occupies enough of the viewport and is not cut off.
- Yaw, pitch, and roll stay within chosen limits for a mostly frontal face.
- Lighting and contrast are adequate; image is not heavily blurred.
- Motion is low enough to avoid a transient frame.
- The face has remained usable for a short interval, rather than passing for one frame.

The initial numerical thresholds should be tuned against sample devices and people. Record *why* a frame failed, and select the highest-priority instruction. Avoid implying that a poor camera frame is a poor-looking person.

### Aggregation and result

Collect about three to five valid model predictions, spaced roughly one second apart. Compute a rolling median (or another robust statistic) to suppress blinks and noisy outputs. A result should be revealed only when enough valid samples have arrived; otherwise pause and guide the user. Lock the result after reveal. A new scan may yield a different estimate due to lighting, angle, and expression, so the interface should not claim perfect repeatability.

Define a deterministic mapping from the model's native scale to the displayed 0–100 score. For example, a model returning 1–5 could be mapped linearly for the prototype, but this does **not** create a percentile or calibrate against the general population. Test the resulting distribution before choosing tier thresholds so every user is not compressed into one or two tiers. Keep the exact model version, preprocessing, transform, and tier thresholds documented together.

The live visual effects can respond to pose, expression, and progress. The displayed rating should remain hidden during sampling, then settle into a single final number. Show quality as a separate status, never as a deduction from the rating.

## 6. Architecture

| Component | Proposed MVP implementation | Responsibility |
| --- | --- | --- |
| Web UI | React, TypeScript, Vite | Camera flow, scan states, overlays, result and share card |
| Camera | `getUserMedia` | Front-facing video after explicit permission |
| Face tracking | MediaPipe Face Landmarker for Web | One-face landmarks and data for alignment/guidance |
| Quality checks | Browser TypeScript module | Pose, framing, motion, brightness, blur and frame eligibility |
| Rating API | Small Python service, such as FastAPI | Preprocess selected frame, run model, return native score and version |
| Hosting | Static frontend plus HTTPS inference endpoint | Serve app and model; no database required for MVP |
| Observability | Aggregate events and API logs without image payloads | Find permission, device, latency and completion failures |

**Data flow:** camera frame → local tracker and quality gate → selected face crop → HTTPS inference → prediction buffer → stable result → optional locally rendered card. The app should never upload a frame merely because camera permission was granted; upload starts only during a scan with an eligible frame.

### Minimal API contract

`POST /v1/score` accepts one bounded image crop, a `scan_id`, and a monotonically increasing `frame_sequence`. It returns `native_score`, `model_version`, and a request ID. The client owns quality prompts and final aggregation; the service owns model-specific preprocessing and inference. Reject oversize payloads, malformed images, and unsupported formats. Set short timeouts and use rate limits appropriate to an anonymous public endpoint.

A `GET /health` endpoint may report readiness and model version without exposing private data. Do not include raw images in request logs or error traces. The server should discard image bytes after inference and avoid caches or backups containing them.

## 7. Model choice and validation

MediaPipe supplies landmarks and expression-related outputs; it does **not** supply an attractiveness score. A separate model is required for that feature. A public ResNet-50 model trained on SCUT-FBP5500 is one research prototype candidate with a 1–5 rating output. The SCUT-FBP5500 dataset states that it is for **noncommercial research only**. Model availability on a public repository does not by itself grant commercial rights to its training data or weights. Select and verify a permitted model and dataset before a public or monetized launch.

Model selection checklist:

1. Confirm the license and provenance of code, weights, and training images/labels separately.
2. Document the training population, rating process, output range, preprocessing, and known limitations.
3. Measure score variation across repeated scans of the same consenting person under reasonable lighting and movement.
4. Review error and score distributions across relevant demographic groups with an appropriately consented evaluation set. Avoid claiming fairness on the basis of a small or unrepresentative sample.
5. Check latency and memory cost at the intended deployment size.
6. Decide whether the model is reliable enough to show a numeric result. If not, revise the framing and model before launch.

The score should never be marketed as scientific truth. Avoid fabricated explanations such as claiming that a specific facial feature caused a score unless the model actually supports that attribution. Photo tips about lighting and pose can be generated from the quality checks without making claims about a person's appearance.

## 8. Privacy and consent

- Ask for camera access only after `Start scan`; explain whether selected frames will be sent to the scoring service.
- Keep the camera preview and tracking local. Transmit only selected face crops needed for inference over HTTPS.
- Do not save images, video, face embeddings, or scores to a persistent store by default. Do not use uploaded frames to train a model without separate, explicit consent.
- Stop camera tracks on exit, navigation away, or component cleanup. Clear in-memory frame buffers after result/exit.
- Generate share cards only on user action; provide a face-free option. Never publish results automatically.
- Avoid identifying the user, predicting sensitive traits, or letting another person covertly scan bystanders. Pause if multiple faces enter the frame.
- If analytics are used, collect event counts and performance only, such as `camera_started`, `quality_gate_failed`, `scan_completed`, and `share_tapped`; omit images and biometric measurements.

Before public launch, review applicable consent and privacy requirements for the actual jurisdictions and deployment. The MVP design should minimize data handling regardless of legal classification.

## 9. Failure behavior

| Situation | Expected response |
| --- | --- |
| Camera denied or unavailable | Show a plain explanation and retry path; do not show a fake scan |
| No face or multiple faces | Pause sampling and request one face in frame |
| Low light, angle, blur or motion | Show the most useful correction; preserve valid progress briefly |
| Slow inference | Keep the overlay responsive, display scanning state, and time out gracefully |
| Model service unavailable | Show retry; do not invent a score |
| Tab backgrounded or camera switched | Pause and resume acquisition; discard stale requests |
| New scan started | Reset predictions, increment scan ID, ignore old responses |

## 10. Performance targets and acceptance criteria

These are initial engineering targets to test, not verified performance claims.

- Preview and overlay feel responsive on recent midrange phones; tracking may lower cadence on slower devices without stalling the UI.
- First visible guidance appears within a few seconds of camera permission and model initialization on a reasonable connection.
- A cooperative user in good light receives a result after about three to five valid samples, plus network and inference time.
- A bad frame never changes a locked result or causes an abrupt score drop.
- Permission denial, zero/multiple faces, poor quality, timeout, and network failure each produce a clear recoverable state.
- The scan works on current Chrome and Safari mobile releases and a desktop Chromium browser after device testing.
- Network inspection confirms that only selected frames are uploaded for inference and no image persists in application logs or storage.

## 11. Build sequence

1. **Interactive shell:** Landing, permission flow, mirrored camera, responsive overlay and scan states. Use a mock score only for local UI work and label it as such.
2. **Live guidance:** Integrate Face Landmarker and quality checks; test on phones with different lighting and movement.
3. **Real inference:** Add the licensed model candidate, preprocessing, bounded `/v1/score` endpoint, rate limiting, request IDs and stale-response handling.
4. **Stable reveal:** Aggregate predictions, tune thresholds, add result animation, rescan and failure states.
5. **Share and validation:** Render local cards, verify privacy behavior and test score repeatability, latency and completion across devices and consenting participants.

**Launch gate:** Do not publicly ship the rating feature until model and dataset rights, score behavior, and privacy handling have been checked. A live tracking demo can be tested independently while model selection is unresolved.

## References

- [MediaPipe Face Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [SCUT-FBP5500 dataset and usage restriction](https://github.com/HCIILAB/SCUT-FBP5500-Database-Release)
- [Example SCUT-trained model card](https://huggingface.co/evanlyhf/scut-fbp5500-beauty)
