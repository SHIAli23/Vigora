"""Incidents as seen by the 112 operator."""

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notify
from app.database import get_db, utcnow
from app.deps import require_role
from app.models import OPEN_STATUSES, OPERATOR, Incident, Team, User
from app.schemas import AssignIn
from app.services.assignment import rank_teams
from app.services.incidents import (
    IncidentError,
    assign_team,
    incident_detail,
    incident_summary,
    mark_false,
    resolve_by_operator,
    team_view,
)

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


def _get_incident(db: Session, incident_id: int) -> Incident:
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сигналът не е намерен")
    return incident


async def _after_change(db: Session, incident: Incident, teams: list[Team | None]) -> dict[str, Any]:
    """Commit, tell everyone who needs to know, and return the incident summary."""
    db.commit()
    now = utcnow()
    await notify.incident_changed(incident, now)
    for team in {team for team in teams if team is not None}:
        await notify.team_changed(team)
    return incident_summary(incident, now)


@router.get("/{incident_id}")
def get_incident(
    incident_id: int,
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident = _get_incident(db, incident_id)
    detail = incident_detail(incident, utcnow())
    detail["team_candidates"] = [
        {
            **team_view(candidate.team),
            "distance_m": round(candidate.distance_m),
            "eta_min": candidate.eta_min,
            "preferred": candidate.preference == 0,
        }
        for candidate in rank_teams(db, incident)
    ]
    return detail


@router.post("/{incident_id}/assign")
async def assign(
    incident_id: int,
    body: AssignIn,
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident = _get_incident(db, incident_id)
    team = db.get(Team, body.team_id)
    if team is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Екипът не е намерен")
    try:
        previous = assign_team(db, incident, team, utcnow())
    except IncidentError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    return await _after_change(db, incident, [previous, team])


@router.post("/{incident_id}/resolve")
async def resolve(
    incident_id: int,
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident = _get_incident(db, incident_id)
    try:
        team = resolve_by_operator(db, incident, utcnow())
    except IncidentError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    return await _after_change(db, incident, [team])


@router.post("/{incident_id}/false")
async def false_report(
    incident_id: int,
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident = _get_incident(db, incident_id)
    try:
        team = mark_false(db, incident, utcnow())
    except IncidentError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    return await _after_change(db, incident, [team])
