"""Pushes incident and team changes to the right connected users."""

from datetime import datetime

from app.models import Incident, Team, WitnessRequest
from app.realtime import manager
from app.rules import WITNESS_ANSWER_WINDOW_MIN, get_type, witness_question_text
from app.services.incidents import STATUS_LABELS, incident_summary, iso, team_view


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
    """Ask each nearby citizen whether they can confirm the incident."""
    incident_type = get_type(incident.type)
    for request in requests:
        await manager.to_user(
            request.user_id,
            "witness.question",
            {
                "request_id": request.id,
                "incident_id": incident.id,
                "type": incident.type,
                "type_label": incident_type.label,
                "question": witness_question_text(incident_type),
                "violent": incident_type.violent,
                "distance_m": round(request.distance_m),
                "lat": incident.lat,
                "lng": incident.lng,
                "asked_at": iso(request.asked_at),
                "expires_in_min": WITNESS_ANSWER_WINDOW_MIN,
            },
        )
