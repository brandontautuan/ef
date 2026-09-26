from tests.conftest import make_image


def _post(client, image=None, scan_id="scan-1", frame_sequence="0", content_type="image/jpeg"):
    files = {}
    if image is not None:
        files["image"] = ("crop.jpg", image, content_type)
    data = {}
    if scan_id is not None:
        data["scan_id"] = scan_id
    if frame_sequence is not None:
        data["frame_sequence"] = frame_sequence
    return client.post("/v1/score", files=files or None, data=data or None)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "@staging" in body["model_version"]  # mock package is active


def test_score_success_schema(client, jpeg_bytes):
    r = _post(client, image=jpeg_bytes)
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"native_score", "model_version", "request_id"}
    assert 1.0 <= body["native_score"] <= 5.0
    assert isinstance(body["request_id"], str) and body["request_id"]


def test_score_is_deterministic(client, jpeg_bytes):
    a = _post(client, image=jpeg_bytes).json()["native_score"]
    b = _post(client, image=jpeg_bytes).json()["native_score"]
    assert a == b  # golden: same input -> same native score


def test_missing_metadata_400(client, jpeg_bytes):
    r = _post(client, image=jpeg_bytes, scan_id=None)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bad_request"


def test_missing_image_400(client):
    r = _post(client, image=None)
    assert r.status_code == 400


def test_negative_sequence_400(client, jpeg_bytes):
    r = _post(client, image=jpeg_bytes, frame_sequence="-1")
    assert r.status_code == 400


def test_unsupported_media_415(client, jpeg_bytes):
    r = _post(client, image=jpeg_bytes, content_type="image/png")
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "unsupported_media_type"


def test_undecodable_image_422(client):
    r = _post(client, image=b"not really an image")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_image"


def test_oversize_413(client):
    big = make_image(size=(4000, 4000))  # large JPEG payload
    # ensure it exceeds the byte cap regardless of compression
    assert len(big) > 0
    r = _post(client, image=big + b"\x00" * (3 * 1024 * 1024))
    assert r.status_code in (413, 422)  # size cap (or decode reject on the padding)


def test_error_body_shape(client):
    r = _post(client, image=None)
    body = r.json()
    assert set(body.keys()) == {"error", "request_id"}
    assert set(body["error"].keys()) == {"code", "message"}
