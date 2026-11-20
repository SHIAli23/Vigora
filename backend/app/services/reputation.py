"""Hidden reputation of the citizens who reported an incident."""

from app.models import ANSWER_YES, Incident, User

NEUTRAL_TRUST = 50.0
MIN_TRUST = 0
MAX_TRUST = 100
RESOLVED_BONUS = 5
FALSE_REPORT_PENALTY = 15
FALSE_WITNESS_PENALTY = 5


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


def adjust_trust(user: User, change: int) -> None:
    """Change a user's trust, keeping it within 0-100."""
    user.trust = max(MIN_TRUST, min(MAX_TRUST, user.trust + change))


def on_incident_resolved(incident: Incident) -> None:
    """A real incident: everyone who reported it becomes more trusted."""
    for user in reporters(incident):
        adjust_trust(user, RESOLVED_BONUS)


def on_false_report(incident: Incident) -> None:
    """A false report: the reporters and the witnesses who confirmed it become less trusted."""
    for user in reporters(incident):
        adjust_trust(user, -FALSE_REPORT_PENALTY)
    for request in incident.witness_requests:
        if request.answer == ANSWER_YES:
            adjust_trust(request.user, -FALSE_WITNESS_PENALTY)
