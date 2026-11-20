"""Finding citizens near a new incident and asking them to confirm it.

A citizen's app sends its location over the open WebSocket. Only an approximate point
(rounded to about 100 m) is kept, and only in this process's memory: locations are never
written to the database. They are removed when the citizen turns sharing off or closes
their last connection, expire after LOCATION_MAX_AGE_MIN, and are lost on restart.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock

from sqlalchemy.orm import Session

from app.models import Incident, WitnessRequest
from app.rules import LOCATION_MAX_AGE_MIN, MAX_WITNESSES_PER_INCIDENT, get_type
from app.services.geo import approximate, distance_m


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


def find_witnesses(
    incident: Incident,
    locations: dict[int, SharedLocation],
    exclude_user_ids: set[int],
) -> list[tuple[int, float]]:
    """People within the type's witness radius, as (user_id, distance_m), closest first.

    At most MAX_WITNESSES_PER_INCIDENT are returned.
    """
    radius = get_type(incident.type).witness_radius_m
    nearby = []
    for user_id, location in locations.items():
        if user_id in exclude_user_ids:
            continue
        distance = distance_m(incident.lat, incident.lng, location.lat, location.lng)
        if distance <= radius:
            nearby.append((user_id, distance))
    nearby.sort(key=lambda item: item[1])
    return nearby[:MAX_WITNESSES_PER_INCIDENT]


def create_requests(
    db: Session,
    incident: Incident,
    witnesses: list[tuple[int, float]],
    now: datetime,
) -> list[WitnessRequest]:
    """Create a question for each witness who has not been asked about this incident yet."""
    already_asked = {request.user_id for request in incident.witness_requests}
    created = []
    for user_id, distance in witnesses:
        if user_id in already_asked:
            continue
        request = WitnessRequest(user_id=user_id, distance_m=round(distance), asked_at=now)
        incident.witness_requests.append(request)
        already_asked.add(user_id)
        created.append(request)
    db.flush()
    return created
