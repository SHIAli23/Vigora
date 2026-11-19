"""Hidden reputation of the citizens who reported an incident."""

from app.models import Incident, User

NEUTRAL_TRUST = 50.0


def reporters(incident: Incident) -> list[User]:
    """The unique users who sent reports for the incident, in the order they first reported."""
    unique: list[User] = []
    for report in incident.reports:
        if report.user not in unique:
            unique.append(report.user)
    return unique


def average_trust(incident: Incident) -> float:
    """The average trust of the incident's reporters, or 50.0 if there are none."""
    users = reporters(incident)
    if not users:
        return NEUTRAL_TRUST
    return sum(user.trust for user in users) / len(users)
