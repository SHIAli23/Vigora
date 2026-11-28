"""Incident lifecycle (new reports, assigning a team, closing) and the operator's views."""

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    ANSWER_YES,
    OPEN_STATUSES,
    STATUS_ACCEPTED,
    STATUS_ASSIGNED,
    STATUS_FALSE,
    STATUS_NEW,
    STATUS_ON_SCENE,
    STATUS_RESOLVED,
    TEAM_AVAILABLE,
    TEAM_BUSY,
    Incident,
    IncidentEvent,
    Report,
    Team,
    User,
)
from app.rules import TEAM_KIND_LABELS, get_type
from app.services import reputation, urgency
from app.services.dedup import find_matching_incident
from app.services.photo_check import LEVEL_WARNING
from app.services.photos import incident_photo_checks, photo_check_view

STATUS_LABELS = {
    STATUS_NEW: "Приет от 112",
    STATUS_ASSIGNED: "Екипът е уведомен",
    STATUS_ACCEPTED: "Екип на път",
    STATUS_ON_SCENE: "Екипът е на място",
    STATUS_RESOLVED: "Приключен",
    STATUS_FALSE: "Отхвърлен",
}

# The statuses a team can set, and the incident statuses each one can follow.
TEAM_TRANSITIONS = {
    STATUS_ACCEPTED: (STATUS_ASSIGNED,),
    STATUS_ON_SCENE: (STATUS_ASSIGNED, STATUS_ACCEPTED),
    STATUS_RESOLVED: (STATUS_ACCEPTED, STATUS_ON_SCENE),
}


class IncidentError(ValueError):
    """An operator action that is not allowed. The message is shown to the operator."""


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


def _free_team(incident: Incident) -> Team | None:
    """Make the incident's assigned team available again. Returns that team, or None."""
    team = incident.assigned_team
    if team is None or team.current_incident_id != incident.id:
        return None
    team.status = TEAM_AVAILABLE
    team.current_incident_id = None
    return team


def assign_team(db: Session, incident: Incident, team: Team, now: datetime) -> Team | None:
    """Send a team to the incident. Returns the team that was assigned before, if any."""
    if incident.status not in (STATUS_NEW, STATUS_ASSIGNED):
        raise IncidentError("Сигналът вече е поет от екип")
    if team.status != TEAM_AVAILABLE:
        raise IncidentError("Екипът не е свободен")
    if team.kind not in get_type(incident.type).team_kinds:
        raise IncidentError("Този вид екип не е подходящ за сигнала")

    previous = _free_team(incident)
    team.status = TEAM_BUSY
    team.current_incident_id = incident.id
    incident.assigned_team = team
    incident.status = STATUS_ASSIGNED
    incident.assigned_at = now
    add_event(incident, f"Назначен: {team.name}", now)
    db.flush()
    return previous


def _close(incident: Incident, status: str, text: str, now: datetime) -> Team | None:
    if incident.status not in OPEN_STATUSES:
        raise IncidentError("Сигналът вече е приключен")
    incident.status = status
    incident.closed_at = now
    add_event(incident, text, now)
    return _free_team(incident)


def resolve_by_operator(db: Session, incident: Incident, now: datetime) -> Team | None:
    """Close a real incident. Returns the team that was freed, if any."""
    team = _close(incident, STATUS_RESOLVED, "Приключен от оператор", now)
    reputation.on_incident_resolved(incident)
    db.flush()
    return team


def mark_false(db: Session, incident: Incident, now: datetime) -> Team | None:
    """Close the incident as a false report. Returns the team that was freed, if any."""
    team = _close(incident, STATUS_FALSE, "Маркиран като фалшив сигнал", now)
    reputation.on_false_report(incident)
    db.flush()
    return team


def update_by_team(
    db: Session, incident: Incident, team: Team, new_status: str, now: datetime
) -> None:
    """A team reports its progress on its task. Raises IncidentError."""
    if incident.assigned_team_id != team.id or team.current_incident_id != incident.id:
        raise IncidentError("Сигналът не е назначен на вашия екип")
    if incident.status not in TEAM_TRANSITIONS.get(new_status, ()):
        raise IncidentError("Невъзможна смяна на статуса")

    incident.status = new_status
    add_event(incident, f"{team.name}: {STATUS_LABELS[new_status].lower()}", now)
    if new_status == STATUS_ON_SCENE:
        team.lat, team.lng = incident.lat, incident.lng
    elif new_status == STATUS_RESOLVED:
        incident.closed_at = now
        _free_team(incident)
        reputation.on_incident_resolved(incident)
    db.flush()


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
        # True when any photo has a warning, for the "suspicious photo" mark in the queue.
        "photo_warning": any(
            check.level == LEVEL_WARNING for check in incident_photo_checks(incident)
        ),
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
    """The summary plus the reports, witness photos, photo checks and history."""
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
    detail["photo_checks"] = [photo_check_view(check) for check in incident_photo_checks(incident)]
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
