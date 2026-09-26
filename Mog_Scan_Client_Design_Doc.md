# Mog Scan MVP — Client Experience and Scan Orchestration

**Owner:** Engineer A (web/client)  
**Status:** Implementation design  
**Depends on:** the scoring API contract in `Mog_Scan_Service_Design_Doc.md`

## 1. Purpose and boundary

This workstream owns the browser experience from landing page through an optional locally rendered share card. It owns camera permission, the live preview, MediaPipe landmark tracking, quality guidance, scan state transitions, selection of eligible frames, prediction aggregation, and all user-visible failure handling.

It does **not** own face-crop preprocessing for the rating model, model weights, score normalization, service rate limiting, or server logging. Its only scoring dependency is `POST /v1/score`.

## 2. User-facing outcome

A person explicitly starts a scan, sees a mirrored front-camera preview and one actionable prompt, holds a usable pose while three to five eligible frames are scored, then sees one locked 0–100 result and tier. They can start over or save a face-inclusive or face-free card. No score is shown while acquiring or sampling.

## 3. Technical shape

- React + TypeScript + Vite.
- `getUserMedia` with `{ facingMode: "user" }`; request it only after `Start scan`.
- MediaPipe Face Landmarker runs locally against the preview at a device-appropriate cadence.
- Browser quality module determines whether a frame is eligible; only eligible frames are cropped and sent to the service.
- A client scoring module permits one in-flight request, associates each request with a scan ID and increasing sequence number, and ignores stale responses.
- Canvas renders the share card locally. No card is uploaded automatically.

Keep tracking and rendering responsive even while requests are pending. Use a worker where supported for the expensive local analysis; fall back to lower cadence/resolution before blocking the main thread.

## 4. State machine

| State | Client behavior | Transitions |
| --- | --- | --- |
| `idle` | Landing explanation and `Start scan` | start → `permission` |
| `permission` | Request camera; initialize tracker | granted → `acquiring`; denied/error → `error` |
| `acquiring` | Preview, overlay, one current quality prompt | stable usable face → `sampling` |
| `sampling` | Preserve preview; collect predictions at ~1 Hz | enough predictions → `result`; sustained gate failure → `paused`; timeout/error → `error` |
| `paused` | Preserve partial valid progress and show correction | quality restored → `sampling`; overall timeout → `error` |
| `result` | Stop sampling; lock result, rescan/share actions | rescan → fresh `acquiring`; exit → cleanup/`idle` |
| `error` | Plain-language explanation and retry | retry → `permission` or `acquiring`; exit → cleanup/`idle` |

Use two timers: a brief quality-failure grace period (so a blink does not reset progress) and a longer overall scan timeout. A new scan creates a new `scanId`, clears prediction state, and invalidates every prior response.

## 5. Local analysis and guidance

For every analyzed frame, derive a `QualityAssessment`:

```ts
type QualityFailure =
  | 'no_face' | 'multiple_faces' | 'too_small' | 'cut_off'
  | 'pose' | 'dark' | 'blur' | 'motion';

type QualityAssessment = {
  eligible: boolean;
  failures: QualityFailure[];
  faceBounds?: { x: number; y: number; width: number; height: number };
  pose?: { yaw: number; pitch: number; roll: number };
};
```

Initial thresholds are configuration, not hard-coded product truth. The client picks one prompt using the following priority: multiple/no face → framing → pose → light → motion/blur. Prompt copy is about the camera frame (for example, “Find brighter light”), never about a person’s appearance.

Eligible frames must meet all of these conditions:

1. Exactly one reliable face is present and fully in frame.
2. Face size and frontal-pose values are within configured limits.
3. Brightness/contrast, blur, and motion pass their configured thresholds.
4. The gate has remained valid for the configured hold interval.

The client draws the face overlay from landmarks but should not persist landmarks, biometric values, frames, or result data beyond the active view.

## 6. Scoring client contract

At roughly one-second intervals during `sampling`, the client crops an eligible image, encodes it within the service size limit, and calls the service. It may not transmit a frame merely because camera permission was granted.

```ts
type ScoreRequest = {
  scan_id: string;
  frame_sequence: number;
  image: Blob; // bounded JPEG/WebP crop; exact content type agreed with service
};

type ScoreResponse = {
  native_score: number;
  model_version: string;
  request_id: string;
};
```

On a response, accept it only if its `scan_id` is still active and its `frame_sequence` has not been superseded. Network, timeout, validation, and `5xx` errors use the recoverable model-error state; never manufacture a score.

## 7. Aggregation and display configuration

Once the client has `requiredPredictionCount` valid responses (initial target: 3–5), sort the native scores and use the configured robust aggregate (initially median). Convert the aggregate into display score and tier using a **versioned configuration supplied by the service owner**:

```ts
type DisplayScoreConfig = {
  modelVersion: string;
  nativeMin: number;
  nativeMax: number;
  tiers: Array<{ minInclusive: number; maxInclusive: number; label: string; targetShare: number }>;
};
```

The client must not invent or silently change a scale. It should record the returned model version with the current in-memory result and refuse mixed-version predictions in one scan. The final view includes a concise “model estimate from this scan” note.

### Current tier configuration

| Tier | Display score | Target share of valid scans | Approx. per 10,000 distinct people |
| --- | ---: | ---: | ---: |
| `TRUE ADAM` | 99–100 | 0.05% | 5 |
| `ADAM` | 95–98 | 0.45% | 45 |
| `CHAD` | 88–94 | 1.5% | 150 |
| `CHADLITE` | 80–87 | 3% | 300 |
| `HTN` | 70–79 | 15% | 1,500 |
| `MTN` | 60–69 | 35% | 3,500 |
| `LTN` | 50–59 | 30% | 3,000 |
| `SUB5` | 0–49 | 15% | 1,500 |

The target share is a post-validation calibration objective across valid scans; it is not an individual’s percentile or a promise that live traffic will exactly match this distribution. The client uses only the range-to-label mapping above.

## 8. Components and ownership inside the client

| Module | Responsibility |
| --- | --- |
| `CameraController` | Permission, stream lifecycle, mirroring, stop tracks on cleanup |
| `FaceTracker` | MediaPipe initialization, landmark results, device cadence |
| `QualityGate` | Assessment, prompt priority, hold/grace timing |
| `ScanController` | State machine, scan IDs, timers, frame scheduling |
| `ScoreClient` | Bounded upload, one request at a time, cancellation/stale-response filtering |
| `ResultEngine` | Valid prediction buffer, median, configured display mapping |
| `ShareCard` | Local canvas rendering, face-free option, download/share intent |
| `Analytics` | Anonymous event and performance fields only |

## 9. Privacy, cleanup, and instrumentation

Stop all media tracks and clear canvas/frame buffers when the scan exits, the component unmounts, the tab is hidden, or a new scan begins. Pause sampling while hidden or when the camera changes. Do not write images, score history, landmarks, or face crops to local storage.

If enabled, emit only aggregate-safe events such as `camera_started`, `camera_denied`, `quality_gate_failed` (reason only), `sampling_started`, `scan_completed`, `scan_error` (error class), `rescan_tapped`, and `share_tapped`. Never include image bytes, landmarks, native scores, or identifying values.

## 10. Acceptance criteria

- Permission is requested only after explicit start; denied and unsupported-browser flows give a retry path.
- Preview is mirrored and remains responsive while scoring requests occur.
- Multiple/no-face, framing, pose, lighting, motion, blur, timeout, backgrounding, and service failures all have deterministic recoverable behavior.
- A brief tracker miss pauses only after the grace period; a rescan cannot accept old predictions.
- Network inspection shows uploads only for eligible frames during `sampling`.
- A final score appears only after the required valid predictions and remains locked.
- Share cards render locally and offer a no-face option.

## 11. Handoff checkpoints

1. **Contract stub:** Implement the state machine against a mock `ScoreClient`; service owner confirms request/response fixture.
2. **Integration:** Exercise real success, validation error, timeout, and stale-response cases against staging.
3. **Joint device test:** Test current Chrome/Safari mobile and desktop Chromium with a defined set of lighting, movement, and face-count scenarios.
