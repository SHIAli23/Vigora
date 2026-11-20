"""Last known locations of citizens who share them, used to find possible witnesses.

A citizen's app sends its location over the open WebSocket. Only an approximate point
(rounded to about 100 m) is kept, and only in this process's memory: locations are never
written to the database. They are removed when the citizen turns sharing off or closes
their last connection, expire after LOCATION_MAX_AGE_MIN, and are lost on restart.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock

from app.rules import LOCATION_MAX_AGE_MIN
from app.services.geo import approximate


@dataclass(frozen=True)
class SharedLocation:
    """An approximate point and when it was last updated."""

    lat: float
    lng: float
    updated_at: datetime


class LocationStore:
    """The latest approximate location of each citizen who shares it, by user id."""

    def __init__(self) -> None:
        self._locations: dict[int, SharedLocation] = {}
        # Read from normal endpoints, which FastAPI runs in several threads.
        self._lock = Lock()

    def update(self, user_id: int, lat: float, lng: float, now: datetime) -> None:
        """Store the user's location, rounded so the exact point is never kept."""
        approx_lat, approx_lng = approximate(lat, lng)
        with self._lock:
            self._locations[user_id] = SharedLocation(approx_lat, approx_lng, now)

    def remove(self, user_id: int) -> None:
        """Forget the user's location, if there is one."""
        with self._lock:
            self._locations.pop(user_id, None)

    def fresh(self, now: datetime) -> dict[int, SharedLocation]:
        """Delete locations older than LOCATION_MAX_AGE_MIN and return a copy of the rest."""
        cutoff = now - timedelta(minutes=LOCATION_MAX_AGE_MIN)
        with self._lock:
            for user_id in [u for u, loc in self._locations.items() if loc.updated_at < cutoff]:
                del self._locations[user_id]
            return dict(self._locations)

    def clear(self) -> None:
        """Forget all locations."""
        with self._lock:
            self._locations.clear()
