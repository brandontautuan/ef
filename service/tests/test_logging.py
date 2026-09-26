import logging

from tests.conftest import make_image


def test_logs_exclude_image_and_pii(client, caplog):
    """Per-request logs must carry only allowed, non-sensitive fields."""
    image = make_image()
    with caplog.at_level(logging.INFO, logger="mogscan.rating"):
        r = client.post(
            "/v1/score",
            files={"image": ("crop.jpg", image, "image/jpeg")},
            data={"scan_id": "super-secret-scan-id-123", "frame_sequence": "7"},
        )
    assert r.status_code == 200
    native = str(r.json()["native_score"])

    log_text = "\n".join(m.getMessage() for m in caplog.records)
    assert "req id=" in log_text
    assert "model=" in log_text
    # No image bytes, no scan_id, no exact score, no raw sequence value leak.
    assert "super-secret-scan-id-123" not in log_text
    assert native not in log_text
    assert "\\xff\\xd8" not in log_text  # jpeg magic escaped
