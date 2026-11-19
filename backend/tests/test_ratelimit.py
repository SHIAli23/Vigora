from datetime import datetime, timedelta

from app.services.ratelimit import RateLimiter

NOW = datetime(2026, 1, 1, 12, 0)


def test_allows_n_then_blocks():
    limiter = RateLimiter(max_count=3, window_minutes=10)

    assert [limiter.allow(1, NOW) for _ in range(3)] == [True, True, True]
    assert limiter.allow(1, NOW) is False


def test_allows_again_after_window():
    limiter = RateLimiter(max_count=2, window_minutes=10)
    limiter.allow(1, NOW)
    limiter.allow(1, NOW + timedelta(minutes=1))

    assert limiter.allow(1, NOW + timedelta(minutes=9)) is False
    assert limiter.allow(1, NOW + timedelta(minutes=10)) is True


def test_users_have_separate_limits():
    limiter = RateLimiter(max_count=1, window_minutes=10)

    assert limiter.allow(1, NOW) is True
    assert limiter.allow(2, NOW) is True
    assert limiter.allow(1, NOW) is False


def test_reset():
    limiter = RateLimiter(max_count=1, window_minutes=10)
    limiter.allow(1, NOW)

    limiter.reset()

    assert limiter.allow(1, NOW) is True
