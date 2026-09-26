# Mog Scan rating service

Stateless scoring API for the Mog Scan MVP, built strictly to
`../Mog_Scan_Service_Design_Doc.md`. It exposes `POST /v1/score` and
`GET /health`, runs model-specific preprocessing + inference, validates the
native score against the model manifest, and returns only
`native_score`, `model_version`, and `request_id`.

**Image-safe:** image bytes are decoded in memory, scored, and released. Nothing
image-derived is persisted, cached, backed up, or logged.

**Launch gate:** only a **mock/staging** model ships (`models/mock-ui-v1`). It is
clearly labeled and must not be used for public rating until a licensed, reviewed
model package replaces it with a new `model_version`.

## Run it

```sh
cd service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Point the client at it by setting `VITE_SCORE_ENDPOINT=http://localhost:8000/v1/score`
(the client posts multipart directly to that URL). Set the service `CORS_ORIGINS`
to the client origin (default `http://localhost:5173`).

## Test

```sh
pip install -r requirements-dev.txt
pytest
```

## Configuration

See `.env.example` for every tunable (payload/pixel limits, deadlines, admission
bounds, rate limits, CORS origins). Deadlines default below the client's 8s
per-request abort.

## Contract summary

`POST /v1/score` — `multipart/form-data`:

| Field | Type | Rules |
| --- | --- | --- |
| `image` | JPEG or WebP binary | Required; bounded size + decoded pixels |
| `scan_id` | string | Required; bounded length |
| `frame_sequence` | non-negative integer | Required |

Success `200`: `{ "native_score", "model_version", "request_id" }`.
Errors: `{ "error": { "code", "message" }, "request_id" }` with statuses
`400/413/415/422/429/503` as documented in the design doc.

## Model package

`models/<version>/manifest.yaml` is the immutable source of truth for
preprocessing and output range; `calibration.json` is the reviewed display map
handed to the client (native scale → 0–100 + tiers). Any change to weights,
transform, range, or calibration ships as a new `model_version`.
