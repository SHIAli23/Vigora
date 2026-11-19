"""Incident lifecycle for new reports, and the incident data sent to the operator."""

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    ANSWER_YES,
    STATUS_ACCEPTED,
    STATUS_ASSIGNED,
    STATUS_FALSE,
    STATUS_NEW,
    STATUS_ON_SCENE,
    STATUS_RESOLVED,
    Incident,
    IncidentEvent,
    Report,
    Team,
    User,
)
from app.rules import TEAM_KIND_LABELS, get_type
from app.services import reputation, urgency
from app.services.dedup import find_matching_incident

STATUS_LABELS = {
    STATUS_NEW: "Приет от 112",
    STATUS_ASSIGNED: "Екипът е уведомен",
    STATUS_ACCEPTED: "Екип на път",
    STATUS_ON_SCENE: "Екипът е на място",
    STATUS_RESOLVED: "Приключен",
    STATUS_FALSE: "Отхвърлен",
}


def add_event(incident: Incident, text: str, now: datetime) -> IncidentEvent:
    """Add a line to the incident's history."""
    event = IncidentEvent(text=text, created_at=now)
    incident.events.append(event)
    return event


def _already_counted(incident: Incident, user: User) -> bool:
    """True if this user already reported the incident or confirmed it as a witness."""
    if any(report.user_id == user.id for report in incident.reports):
        return True
    return any(
        request.user_id == user.id and request.answer == ANSWER_YES
        for request in incident.witness_requests
    )


def submit_report(
    db: Session,
    user: User,
    type_key: str,
    lat: float,
    lng: float,
    description: str,
    people_affected: int,
    photo: str | None,
    now: datetime,
) -> tuple[Report, Incident, bool]:
    """Save a citizen's report. It joins a matching open incident or starts a new one.

    Returns (report, incident, is_new).
    """
    incident = find_matching_incident(db, type_key, lat, lng, now)
    is_new = incident is None

    if incident is None:
        incident = Incident(
            type=type_key,
            status=STATUS_NEW,
            lat=lat,
            lng=lng,
            people_affected=people_affected,
            has_photo=photo is not None,
            reports_count=1,
            witness_yes=0,
            witness_no=0,
            witness_unsure=0,
            created_at=now,
            last_report_at=now,
        )
        db.add(incident)
        add_event(incident, f"Нов сигнал: {get_type(type_key).label}", now)
    else:
        incident.last_report_at = now
        incident.people_affected = max(incident.people_affected, people_affected)
        incident.has_photo = incident.has_photo or photo is not None
        if _already_counted(incident, user):
            add_event(incident, "Повторен сигнал от същия човек (не се брои отново)", now)
        else:
            incident.reports_count += 1
            if incident.first_confirmed_at is None:
                incident.first_confirmed_at = now
            add_event(
                incident,
                f"Обединен дублиран сигнал (общо {incident.reports_count} подателя)",
                now,
            )

    report = Report(
        user=user,
        type=type_key,
        lat=lat,
        lng=lng,
        description=description.strip(),
        people_affected=people_affected,
        photo=photo,
        created_at=now,
    )
    incident.reports.append(report)
    db.flush()
    return report, incident, is_new


def iso(dt: datetime | None) -> str | None:
    """A UTC time as an ISO string ending in "Z", or None."""
    if dt is None:
        return None
    return dt.isoformat() + "Z"


def incident_summary(incident: Incident, now: datetime) -> dict[str, Any]:
    """The incident as shown in the operator's list, with its urgency explained."""
    result = urgency.calculate(incident, reputation.average_trust(incident), now)
    team = incident.assigned_team
    return {
        "id": incident.id,
        "type": incident.type,
        "type_label": get_type(incident.type).label,
        "status": incident.status,
        "status_label": STATUS_LABELS.get(incident.status, incident.status),
        "lat": incident.lat,
        "lng": incident.lng,
        "people_affected": incident.people_affected,
        "has_photo": incident.has_photo,
        "reports_count": incident.reports_count,
        "witness_yes": incident.witness_yes,
        "witness_no": incident.witness_no,
        "witness_unsure": incident.witness_unsure,
        "witnesses_asked": len(incident.witness_requests),
        "confirmed": incident.reports_count > 1 or incident.witness_yes > 0,
        "urgency": result.score,
        "level": result.level,
        "urgency_breakdown": result.breakdown,
        "assigned_team": {"id": team.id, "name": team.name, "kind": team.kind} if team else None,
        "created_at": iso(incident.created_at),
        "last_report_at": iso(incident.last_report_at),
        "first_confirmed_at": iso(incident.first_confirmed_at),
        "closed_at": iso(incident.closed_at),
    }


def incident_detail(incident: Incident, now: datetime) -> dict[str, Any]:
    """The summary plus the reports, witness photos and history."""
    detail = incident_summary(incident, now)
    detail["reports"] = [
        {
            "id": report.id,
            "description": report.description,
            "people_affected": report.people_affected,
            "photo": report.photo,
            "reporter_trust": report.user.trust,
            "created_at": iso(report.created_at),
        }
        for report in incident.reports
    ]
    detail["witness_photos"] = [
        request.photo for request in incident.witness_requests if request.photo
    ]
    detail["events"] = [
        {"text": event.text, "created_at": iso(event.created_at)} for event in incident.events
    ]
    return detail


def team_view(team: Team) -> dict[str, Any]:
    """A response team as shown on the operator's map."""
    return {
        "id": team.id,
        "name": team.name,
        "kind": team.kind,
        "kind_label": TEAM_KIND_LABELS.get(team.kind, team.kind),
        "lat": team.lat,
        "lng": team.lng,
        "status": team.status,
        "current_incident_id": team.current_incident_id,
    }
