"""Tests for suggesting a response team."""

from app.database import SessionLocal
from app.models import TEAM_BUSY, Incident, Team
from app.services.assignment import suggest_team
from tests.conftest import auth, login, send_report


def candidates(client, type_):
    incident_id = send_report(client, login(client, "citizen1"), type_).json()["incident_id"]
    response = client.get(f"/api/incidents/{incident_id}", headers=auth(login(client, "operator")))
    assert response.status_code == 200
    return incident_id, response.json()["team_candidates"]


def test_medical_gets_only_medical_teams_closest_first(client):
    _, teams = candidates(client, "medical")

    assert [t["kind"] for t in teams] == ["medical", "medical"]
    distances = [t["distance_m"] for t in teams]
    assert distances == sorted(distances)
    assert all(t["preferred"] for t in teams)
    assert all(t["eta_min"] >= 1 for t in teams)


def test_accident_lists_medical_first_then_police(client):
    _, teams = candidates(client, "accident")

    assert [t["kind"] for t in teams] == ["medical", "medical", "police", "police"]
    assert [t["preferred"] for t in teams] == [True, True, False, False]


def test_busy_team_is_not_suggested(client):
    incident_id, teams = candidates(client, "medical")
    closest = teams[0]["id"]

    with SessionLocal() as db:
        db.get(Team, closest).status = TEAM_BUSY
        db.commit()
        suggestion = suggest_team(db, db.get(Incident, incident_id))

    assert suggestion is not None
    assert suggestion.team.id == teams[1]["id"]


def test_no_available_team_gives_no_suggestion(client):
    incident_id, _ = candidates(client, "fire")

    with SessionLocal() as db:
        for team in db.query(Team).filter(Team.kind == "fire"):
            team.status = TEAM_BUSY
        db.commit()
        assert suggest_team(db, db.get(Incident, incident_id)) is None
