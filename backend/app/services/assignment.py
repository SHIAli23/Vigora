"""Suggesting which response team should take an incident."""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import TEAM_AVAILABLE, Incident, Team
from app.rules import get_type
from app.services.geo import distance_m

# About 30 km/h, a typical speed in city traffic.
METERS_PER_MINUTE = 500


@dataclass
class Candidate:
    """A team that can respond to an incident, and how far away it is."""

    team: Team
    distance_m: float
    eta_min: int
    # The index of the team's kind in the incident type's team_kinds. 0 is the best fit.
    preference: int


def rank_teams(db: Session, incident: Incident) -> list[Candidate]:
    """Available teams of a suitable kind, the best kind first, then the closest first."""
    team_kinds = get_type(incident.type).team_kinds
    teams = db.scalars(
        select(Team).where(Team.status == TEAM_AVAILABLE, Team.kind.in_(team_kinds))
    )
    candidates = []
    for team in teams:
        distance = distance_m(incident.lat, incident.lng, team.lat, team.lng)
        candidates.append(
            Candidate(
                team=team,
                distance_m=distance,
                eta_min=max(1, round(distance / METERS_PER_MINUTE)),
                preference=team_kinds.index(team.kind),
            )
        )
    candidates.sort(key=lambda c: (c.preference, c.distance_m))
    return candidates


def suggest_team(db: Session, incident: Incident) -> Candidate | None:
    """The best team for the incident, or None if no suitable team is available."""
    candidates = rank_teams(db, incident)
    return candidates[0] if candidates else None
