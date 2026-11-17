"""Explainable urgency score: every point comes with a label that says where it came from."""

from dataclasses import dataclass, field
from datetime import datetime

from app.models import STATUS_NEW, Incident
from app.rules import get_type

# Weights. They will be tuned later.
PER_PERSON = 10
MAX_PEOPLE = 5
PER_CONFIRMATION = 8
MAX_CONFIRMATIONS = 6
PHOTO_BONUS = 5
PER_MINUTE_WAITING = 0.5
MAX_WAIT_POINTS = 15
PER_DENIAL = 10
TRUST_DIVISOR = 5

# (minimum score, level), from the highest to the lowest.
LEVELS = [(90, "critical"), (65, "high"), (40, "medium"), (0, "low")]


@dataclass
class Urgency:
    score: int
    level: str
    # Each item is {"label": str, "points": int}.
    breakdown: list[dict] = field(default_factory=list)


def level_for(score: float) -> str:
    """The urgency level for a score."""
    for minimum, level in LEVELS:
        if score >= minimum:
            return level
    return LEVELS[-1][1]


def calculate(incident: Incident, avg_trust: float, now: datetime) -> Urgency:
    """Calculate the urgency of an incident and explain each part of the score."""
    parts: list[tuple[str, float]] = []
    incident_type = get_type(incident.type)

    parts.append((f"Тип: {incident_type.label}", incident_type.base_score))

    people = incident.people_affected or 0
    if people > 0:
        parts.append((f"Засегнати хора: {people}", PER_PERSON * min(people, MAX_PEOPLE)))

    confirmations = max((incident.reports_count or 1) - 1, 0) + (incident.witness_yes or 0)
    if confirmations > 0:
        parts.append(
            (
                f"Потвърждения: {confirmations}",
                PER_CONFIRMATION * min(confirmations, MAX_CONFIRMATIONS),
            )
        )

    if incident.has_photo:
        parts.append(("Има снимка", PHOTO_BONUS))

    # Waiting adds points only until an operator acts on the incident.
    if incident.status == STATUS_NEW and incident.created_at is not None:
        minutes = max((now - incident.created_at).total_seconds() / 60, 0)
        wait_points = min(minutes * PER_MINUTE_WAITING, MAX_WAIT_POINTS)
        if wait_points >= 1:
            parts.append((f"Чака {int(minutes)} мин", wait_points))

    denials = incident.witness_no or 0
    if denials > 0:
        parts.append((f"Отхвърляния от свидетели: {denials}", -PER_DENIAL * denials))

    trust_points = (avg_trust - 50) / TRUST_DIVISOR
    if abs(trust_points) >= 1:
        parts.append(("Репутация на подателите", trust_points))

    score = max(round(sum(points for _, points in parts)), 0)
    breakdown = [{"label": label, "points": round(points)} for label, points in parts]
    return Urgency(score=score, level=level_for(score), breakdown=breakdown)
