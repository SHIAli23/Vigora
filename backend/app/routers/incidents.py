"""Incidents as seen by the 112 operator."""

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db, utcnow
from app.deps import require_role
from app.models import OPEN_STATUSES, OPERATOR, Incident, User
from app.services.incidents import incident_detail, incident_summary

router = APIRouter(prefix="/api/incidents", tags=["incidents"])

CLOSED_LIMIT = 50


def _open(db: Session) -> list[Incident]:
    return list(db.scalars(select(Incident).where(Incident.status.in_(OPEN_STATUSES))))


def _closed(db: Session) -> list[Incident]:
    """The newest closed incidents."""
    return list(
        db.scalars(
            select(Incident)
            .where(Incident.status.not_in(OPEN_STATUSES))
            .order_by(Incident.closed_at.desc(), Incident.id.desc())
            .limit(CLOSED_LIMIT)
        )
    )


@router.get("")
def list_incidents(
    scope: Literal["open", "closed", "all"] = Query("open"),
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """Incidents sorted by urgency, the highest first. Equal urgency: the oldest first.

    "all" is the open incidents plus the newest closed ones.
    """
    incidents = []
    if scope in ("open", "all"):
        incidents += _open(db)
    if scope in ("closed", "all"):
        incidents += _closed(db)

    now = utcnow()
    summaries = [incident_summary(incident, now) for incident in incidents]
    # created_at is an ISO string in UTC, so it sorts in time order.
    summaries.sort(key=lambda s: (-s["urgency"], s["created_at"]))
    return summaries


@router.get("/{incident_id}")
def get_incident(
    incident_id: int,
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сигналът не е намерен")
    return incident_detail(incident, utcnow())
