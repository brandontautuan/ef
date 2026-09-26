# Mog Scan client

The browser client for the Mog Scan MVP. It requests the front camera only after the user starts a scan, runs MediaPipe Face Landmarker locally for the one-face/framing gate, sends only selected crops to the score service, aggregates three predictions locally, and renders share cards locally.

## Run it

```sh
npm install
npm run dev
```

The app uses an intentional UI-only scoring stub when `VITE_SCORE_ENDPOINT` is absent. It is marked `mock-ui-v1` in code and is only for developing the camera and result flow.

To use the real service, set `VITE_SCORE_ENDPOINT` to the fully qualified `POST /v1/score` endpoint described in `Mog_Scan_Service_Design_Doc.md`. It must accept multipart fields `image`, `scan_id`, and `frame_sequence`, and respond with `native_score` and `model_version`.

## Scan diagnostics

For local development, start Vite with `VITE_SCAN_DEBUG=1`. The browser developer
console will show quality-gate rejections, the selected-frame count, raw model
scores, the median aggregation, score conversion, tier, and model version. It
never logs image data or claims that a particular facial feature caused a score.

```sh
VITE_SCAN_DEBUG=1 VITE_SCORE_ENDPOINT="http://localhost:8000/v1/score" npm run dev
```

The Face Landmarker WASM/model are loaded at runtime from the official MediaPipe CDN and model bucket. Production deployment should serve the app over HTTPS, configure the service CORS origin precisely, and pin/audit those runtime assets before launch.
