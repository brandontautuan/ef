# Mog Scan MVP — Rating Service, Model, and Operational Design

**Owner:** Engineer B (ML/backend)  
**Status:** Implementation design  
**Depends on:** the client request behavior in `Mog_Scan_Client_Design_Doc.md`

## 1. Purpose and boundary

This workstream owns the secure, stateless scoring service: permitted model selection, model-specific input preprocessing, inference, native score validation, model/version metadata, endpoint protection, and image-safe operations. It defines the model-to-display calibration artifact jointly consumed by the client.

It does **not** own camera permission, MediaPipe tracking, local quality prompts, frame selection, scan progress, client-side aggregation, UI, or share-card rendering. The client decides whether a camera frame is eligible and sends only selected crops.

## 2. Preconditions and launch gate

Before public rating use, document and approve the license/provenance of the model code, weights, and training data separately. A model trained on SCUT-FBP5500 cannot be assumed suitable for commercial/public use merely because weights are downloadable; the source dataset describes noncommercial research use. Until rights and basic validation are complete, expose only a mock/staging model and label it accordingly.

The service must keep the product framing accurate: it returns a model estimate, not an objective attractiveness measurement, percentile, identity result, or explanation of facial features.

## 3. API contract

### `POST /v1/score`

The endpoint receives exactly one selected face crop over HTTPS. Multipart form data is recommended so image content is a binary part and metadata stays explicit.

| Field | Type | Rules |
| --- | --- | --- |
| `image` | JPEG or WebP binary | Required; bounded size and decoded dimensions |
| `scan_id` | opaque string | Required; echoed only for client correlation if agreed |
| `frame_sequence` | non-negative integer | Required; client-monotonic within a scan |

Success (`200`):

```json
{
  "native_score": 3.7,
  "model_version": "model-id@weights-id+preprocess-v1",
  "request_id": "opaque-request-id"
}
```

Errors use a stable, non-sensitive body:

```json
{ "error": { "code": "invalid_image", "message": "Use a supported image crop and try again." }, "request_id": "opaque-request-id" }
```

Use `400` for missing/malformed metadata, `413` for size limits, `415` for unsupported content, `422` for undecodable or unsuitable image content, `429` for rate limits, and `503` when inference is unavailable. Do not return stack traces, model internals, image-derived attributes, or inferred identity information.

### `GET /health`

Return readiness and the active `model_version`; it must never expose request history, model files, image data, or credentials.

## 4. Request lifecycle

1. Assign a random `request_id`; validate method, HTTPS deployment, size limits, MIME type, and metadata before decoding.
2. Decode in memory with pixel-count limits to defend against decompression bombs.
3. Apply the versioned model preprocessing exactly: crop handling, color space, resize, alignment policy, normalization, and tensor layout.
4. Run inference with concurrency limits and a bounded queue.
5. Validate the finite native output against its declared native range.
6. Return only `native_score`, `model_version`, and `request_id`.
7. Release image/tensor memory immediately. No persistent image storage, caching, backups, or request-body logs.

Application logs may contain `request_id`, status class, elapsed time, model version, payload byte bucket, and coarse error code. They must not contain raw request bodies, data URLs, image paths, decoded pixels, face embeddings, scores tied to identifiers, or exception dumps that might include any of these.

## 5. Model package and versioning

Package each deployable model with an immutable manifest:

```yaml
model_version: model-id@weights-sha+preprocess-v1
native_score_range: [1.0, 5.0]
input:
  color_space: RGB
  dimensions: [224, 224]
  normalization: documented-per-channel-values
  alignment: documented-policy
license_review: approved-reference
```

The manifest is the source of truth for preprocessing and output range. Any change to weights, transform, score range, or calibration receives a new version. Keep reproducible checksums and a short model card covering training source, rating process, known limitations, intended use, and license review.

## 6. Display calibration artifact

The service owner supplies a reviewed configuration to the client owner for each model version:

```json
{
  "modelVersion": "model-id@weights-sha+preprocess-v1",
  "nativeMin": 1.0,
  "nativeMax": 5.0,
  "tiers": [
    { "minInclusive": 99, "maxInclusive": 100, "label": "TRUE ADAM", "targetShare": 0.0005 },
    { "minInclusive": 95, "maxInclusive": 98, "label": "ADAM", "targetShare": 0.0045 },
    { "minInclusive": 88, "maxInclusive": 94, "label": "CHAD", "targetShare": 0.015 },
    { "minInclusive": 80, "maxInclusive": 87, "label": "CHADLITE", "targetShare": 0.03 },
    { "minInclusive": 70, "maxInclusive": 79, "label": "HTN", "targetShare": 0.15 },
    { "minInclusive": 60, "maxInclusive": 69, "label": "MTN", "targetShare": 0.35 },
    { "minInclusive": 50, "maxInclusive": 59, "label": "LTN", "targetShare": 0.30 },
    { "minInclusive": 0, "maxInclusive": 49, "label": "SUB5", "targetShare": 0.15 }
  ]
}
```

The target shares translate to approximately 5, 45, 150, 300, 1,500, 3,500, 3,000, and 1,500 per 10,000 distinct people, respectively. They are calibration targets measured on an appropriately consented evaluation set, not a percentile displayed to a person or a guaranteed live-traffic distribution. The mapping may linearly transform a native research-model scale to 0–100 for the prototype, but it must never be called a percentile or population calibration. Choose tier boundaries only after inspecting consented evaluation distributions. The service and client owners approve a mapping together, version it, and do not mix prediction versions in a scan.

## 7. Security, abuse, and reliability

- Enforce HTTPS, CORS limited to the deployed client origins, request body and image-pixel limits, strict MIME validation, and decode timeouts.
- Rate-limit by an appropriately privacy-preserving network key and apply a bounded global inference queue. Return `429`/`503` rather than letting load exhaust workers.
- Set request and inference deadlines shorter than the client’s overall scan timeout.
- Run service workers without a writable image volume; keep model artifacts read-only.
- Do not add authentication, user profiles, storage, or analytics that links scans to people in this MVP.
- Monitor aggregate availability, latency percentiles, rate-limit counts, decode failures, inference failures, and model version only.

## 8. Validation plan

### Automated

- Unit tests for MIME/size/pixel validation, preprocessing determinism, finite/range-checked output, error schema, and image-data exclusion from logs.
- Golden-image tests with consented or licensed fixtures to detect preprocessing/model drift.
- Contract tests using the client fixture for success, malformed image, oversize image, timeout, `429`, and `503`.
- Load test validates bounded concurrency and confirms overload sheds requests predictably.

### Model and product validation

- Measure repeat-scan variation for the same consenting participants under reasonable lighting, angle, and expression changes.
- Review latency and error behavior on expected deployment hardware.
- Evaluate outcome/error distributions with an appropriately consented, relevant set before making quality or fairness claims.
- Document limitations; do not provide fabricated per-feature score explanations.

## 9. Acceptance criteria

- The public endpoint accepts only bounded, supported, decodable image crops and returns the documented schema.
- A versioned manifest completely specifies the active model and preprocessing.
- Image bytes are processed in memory and excluded from persistence, caches, backups, logs, traces, and error messages.
- The endpoint provides stable validation/rate-limit/unavailable errors and a non-sensitive request ID.
- Overload is bounded; healthy requests expose latency and readiness without leaking image or model-sensitive data.
- Model rights, score stability, distribution review, and privacy checks are signed off before any public rating launch.

## 10. Handoff checkpoints

1. **Contract fixture:** Give Engineer A a multipart example plus success and error fixtures, exact limits, timeouts, and staging URL/CORS origin.
2. **Calibration handoff:** Provide the model manifest and reviewed display-score configuration before real-client integration.
3. **Joint privacy and device test:** Verify selected-frame-only uploads, stale request behavior, service failure UX, logs, and no-persistence claims before demo/public exposure.
