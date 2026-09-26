from app.rate_limit import RateLimiter


def test_rate_limiter_blocks_after_max():
    rl = RateLimiter(max_requests=3, window_s=60.0)
    ip = "203.0.113.7"
    assert all(rl.allow(ip, now=t) for t in (0.0, 0.1, 0.2))
    assert rl.allow(ip, now=0.3) is False  # 4th within window


def test_rate_limiter_window_slides():
    rl = RateLimiter(max_requests=2, window_s=10.0)
    ip = "203.0.113.9"
    assert rl.allow(ip, now=0.0)
    assert rl.allow(ip, now=1.0)
    assert rl.allow(ip, now=2.0) is False
    assert rl.allow(ip, now=11.5) is True  # first hit aged out


def test_rate_limiter_key_is_not_raw_ip():
    rl = RateLimiter(max_requests=1, window_s=60.0)
    key = rl._key("198.51.100.4")
    assert "198.51.100.4" not in key
    assert len(key) == 64  # sha256 hex
