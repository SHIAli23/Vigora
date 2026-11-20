"""Response teams: the operator's list, and a team's own task."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notify
from app.database import get_db, utcnow
from app.deps import require_role
from app.models import OPERATOR, TEAM, Incident, Team, User
from app.schemas import TeamStatusIn
from app.services.incidents import (
    IncidentError,
    incident_detail,
    incident_summary,
    team_view,
    update_by_team,
)

router = APIRouter(prefix="/api/teams", tags=["teams"])


def _own_team(user: User) -> Team:
    if user.team is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Акаунтът не е свързан с екип")
    return user.team


def _current_task(db: Session, team: Team) -> Incident | None:
    if team.current_incident_id is None:
        return None
    return db.get(Incident, team.current_incident_id)


@router.get("")
def list_teams(
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    return [team_view(team) for team in db.scalars(select(Team).order_by(Team.id))]


@router.get("/me")
def my_team(
    user: User = Depends(require_role(TEAM)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """The user's team and its current task, or null if it has none."""
    team = _own_team(user)
    task = _current_task(db, team)
    return {
        "team": team_view(team),
        "task": incident_detail(task, utcnow()) if task is not None else None,
    }


@router.post("/me/status")
async def update_status(
    body: TeamStatusIn,
    user: User = Depends(require_role(TEAM)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    team = _own_team(user)
    incident = _current_task(db, team)
    if incident is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Нямате активна задача")

    now = utcnow()
    try:
        update_by_team(db, incident, team, body.status, now)
    except IncidentError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    db.commit()

    await notify.incident_changed(incident, now)
    await notify.team_changed(team)
    return incident_summary(incident, now)
