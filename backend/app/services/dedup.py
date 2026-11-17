"""Grouping of reports: a new report about an event that is already known joins its incident."""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import OPEN_STATUSES, Incident
from app.rules import get_type
from app.services.geo import distance_m


def find_matching_incident(
    db: Session, type_key: str, lat: float, lng: float, now: datetime
) -> Incident | None:
    """Return the nearest open incident of the same type within the type's merge radius
    that had a report within the type's merge window, or None."""
    rules = get_type(type_key)
    since = now - timedelta(minutes=rules.merge_window_min)

    candidates = db.scalars(
        select(Incident).where(
            Incident.type == type_key,
            Incident.status.in_(OPEN_STATUSES),
            Incident.last_report_at >= since,
        )
    ).all()

    best: Incident | None = None
    best_distance = float(rules.merge_radius_m)
    for incident in candidates:
        distance = distance_m(lat, lng, incident.lat, incident.lng)
        if distance <= best_distance:
            best, best_distance = incident, distance
    return best
