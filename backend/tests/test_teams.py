"""Tests for the team endpoints and the team's task flow."""

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Incident, Team, User
from tests.conftest import POINT, auth, login, send_report


def team_of(username):
    with SessionLocal() as db:
        return db.scalar(select(User.team_id).where(User.username == username))


def assigned_task(client, username="med1"):
    """Report a medical incident and assign it to the user's team. Returns (incident_id, token)."""
    incident_id = send_report(client, login(client, "citizen1"), "medical").json()["incident_id"]
    response = client.post(
        f"/api/incidents/{incident_id}/assign",
        json={"team_id": team_of(username)},
        headers=auth(login(client, "operator")),
    )
    assert response.status_code == 200
    return incident_id, login(client, username)


def set_status(client, token, value):
    return client.post("/api/teams/me/status", json={"status": value}, headers=auth(token))


def test_operator_lists_all_teams(client):
    response = client.get("/api/teams", headers=auth(login(client, "operator")))

    assert response.status_code == 200
    assert len(response.json()) == 6


def test_citizen_cannot_list_teams(client):
    response = client.get("/api/teams", headers=auth(login(client, "citizen1")))

    assert response.status_code == 403


def test_me_has_no_task_at_first(client):
    response = client.get("/api/teams/me", headers=auth(login(client, "med1")))

    assert response.status_code == 200
    assert response.json()["team"]["id"] == team_of("med1")
    assert response.json()["task"] is None


def test_me_shows_task_after_assignment(client):
    incident_id, token = assigned_task(client)

    task = client.get("/api/teams/me", headers=auth(token)).json()["task"]

    assert task["id"] == incident_id
    assert task["status"] == "assigned"


def test_cannot_jump_from_assigned_to_resolved(client):
    _, token = assigned_task(client)

    response = set_status(client, token, "resolved")

    assert response.status_code == 409
    assert response.json()["detail"] == "Невъзможна смяна на статуса"


def test_full_flow_frees_the_team(client):
    incident_id, token = assigned_task(client)

    assert set_status(client, token, "accepted").json()["status"] == "accepted"
    assert set_status(client, token, "on_scene").json()["status"] == "on_scene"
    response = set_status(client, token, "resolved")

    assert response.status_code == 200
    assert response.json()["status"] == "resolved"
    with SessionLocal() as db:
        team = db.get(Team, team_of("med1"))
        assert team.status == "available"
        assert team.current_incident_id is None
        # The team moved to the incident when it arrived.
        assert (team.lat, team.lng) == POINT
        incident = db.get(Incident, incident_id)
        assert incident.closed_at is not None
        assert "Линейка 1 — Пирогов: екипът е на място" in [e.text for e in incident.events]
        assert db.scalar(select(User.trust).where(User.username == "citizen1")) == 55

    assert client.get("/api/teams/me", headers=auth(token)).json()["task"] is None


def test_status_without_task_is_rejected(client):
    response = set_status(client, login(client, "med1"), "accepted")

    assert response.status_code == 409
    assert response.json()["detail"] == "Нямате активна задача"


def test_unknown_status_is_rejected(client):
    _, token = assigned_task(client)

    assert set_status(client, token, "flying").status_code == 422
