"""Pushes incident and team changes to the right connected users."""

from datetime import datetime

from app.models import Incident, Team, WitnessRequest
from app.realtime import manager
from app.services import push
from app.services.incidents import STATUS_LABELS, incident_summary, team_view
from app.services.witnesses import question_view


async def incident_changed(
    incident: Incident, now: datetime, event: str = "incident.updated"
) -> None:
    """Tell operators, the assigned team and every reporter that the incident changed."""
    summary = incident_summary(incident, now)
    await manager.to_operators(event, summary)

    if incident.assigned_team_id is not None:
        await manager.to_team(incident.assigned_team_id, "team.task", summary)

    # Citizens only see the status, never the urgency or other reporters.
    reporter_ids = {report.user_id for report in incident.reports}
    await manager.to_users(
        reporter_ids,
        "report.status",
        {
            "incident_id": incident.id,
            "status": incident.status,
            "status_label": STATUS_LABELS.get(incident.status, incident.status),
        },
    )


async def team_changed(team: Team) -> None:
    """Tell operators that a team moved or changed status."""
    await manager.to_operators("team.updated", team_view(team))


async def witness_questions(incident: Incident, requests: list[WitnessRequest]) -> None:
    """Ask each nearby citizen whether they can confirm the incident.

    An open app gets the question over WebSocket. A citizen whose app is closed gets a push
    notification instead, if they allowed it.
    """
    for request in requests:
        question = question_view(request)
        if manager.is_connected(request.user_id):
            await manager.to_user(request.user_id, "witness.question", question)
        elif push.push_enabled():
            push.queue(request.user_id, push.question_payload(question))
