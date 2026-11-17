"""A simple in-memory limit on how many actions one user can make in a time window."""

from collections import defaultdict, deque
from datetime import datetime, timedelta
from threading import Lock


class RateLimiter:
    """Allows at most max_count actions per user in any window of window_minutes."""

    def __init__(self, max_count: int, window_minutes: int) -> None:
        self.max_count = max_count
        self.window = timedelta(minutes=window_minutes)
        self._times: dict[int, deque[datetime]] = defaultdict(deque)
        # FastAPI runs normal endpoints in several threads.
        self._lock = Lock()

    def allow(self, user_id: int, now: datetime) -> bool:
        """Record an action and return True, or return False if the user is over the limit."""
        with self._lock:
            times = self._times[user_id]
            while times and times[0] <= now - self.window:
                times.popleft()
            if len(times) >= self.max_count:
                return False
            times.append(now)
            return True

    def reset(self) -> None:
        """Forget all recorded actions."""
        with self._lock:
            self._times.clear()
