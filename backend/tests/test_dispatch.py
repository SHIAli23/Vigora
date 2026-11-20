"""Tests for the operator assigning teams and closing incidents."""

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Team, User
from app.services.reputation import adjust_trust
from tests.conftest import FAR, auth, login, send_report


def team_id(kind):
    with SessionLocal() as db:
        return db.scalar(select(Team.id).where(Team.kind == kind).order_by(Team.id))


def trust_of(username):
    with SessionLocal() as db:
        return db.scalar(select(User.trust).where(User.username == username))


def report(client, type_="medical", **extra):
    return send_report(client, login(client, "citizen1"), type_, **extra).json()["incident_id"]


def post(client, path, **kwargs):
    return client.post(path, headers=auth(login(client, "operator")), **kwargs)


def open_ids(client):
    response = client.get("/api/incidents", headers=auth(login(client, "operator")))
    return [i["id"] for i in response.json()]


def test_assign_team(client):
    incident_id = report(client)
    medical = team_id("medical")

    response = post(client, f"/api/incidents/{incident_id}/assign", json={"team_id": medical})

    assert response.status_code == 200
    assert response.json()["status"] == "assigned"
    assert response.json()["assigned_team"]["id"] == medical
    with SessionLocal() as db:
        team = db.get(Team, medical)
        assert (team.status, team.current_incident_id) == ("busy", incident_id)


def test_wrong_kind_of_team_is_rejected(client):
    incident_id = report(client)

    response = post(client, f"/api/incidents/{incident_id}/assign", json={"team_id": team_id("fire")})

    assert response.status_code == 409
    assert response.json()["detail"] == "Този вид екип не е подходящ за сигнала"


def test_busy_team_cannot_take_a_second_incident(client):
    first = report(client)
    second = report(client, point=FAR)
    medical = team_id("medical")
    assert post(client, f"/api/incidents/{first}/assign", json={"team_id": medical}).status_code == 200

    response = post(client, f"/api/incidents/{second}/assign", json={"team_id": medical})

    assert response.status_code == 409
    assert response.json()["detail"] == "Екипът не е свободен"


def test_reassigning_frees_the_previous_team(client):
    incident_id = report(client)
    with SessionLocal() as db:
        first, second = db.scalars(select(Team.id).where(Team.kind == "medical")).all()
    post(client, f"/api/incidents/{incident_id}/assign", json={"team_id": first})

    response = post(client, f"/api/incidents/{incident_id}/assign", json={"team_id": second})

    assert response.status_code == 200
    with SessionLocal() as db:
        assert db.get(Team, first).status == "available"
        assert db.get(Team, second).status == "busy"


def test_unknown_team_is_not_found(client):
    incident_id = report(client)

    response = post(client, f"/api/incidents/{incident_id}/assign", json={"team_id": 999999})

    assert response.status_code == 404


def test_false_report_lowers_trust_and_closes(client):
    incident_id = report(client)

    response = post(client, f"/api/incidents/{incident_id}/false")

    assert response.status_code == 200
    assert response.json()["status"] == "false_report"
    assert trust_of("citizen1") == 35
    assert incident_id not in open_ids(client)


def test_resolve_raises_trust_and_frees_team(client):
    incident_id = report(client)
    medical = team_id("medical")
    post(client, f"/api/incidents/{incident_id}/assign", json={"team_id": medical})

    response = post(client, f"/api/incidents/{incident_id}/resolve")

    assert response.status_code == 200
    assert response.json()["status"] == "resolved"
    assert trust_of("citizen1") == 55
    with SessionLocal() as db:
        assert db.get(Team, medical).status == "available"


def test_closed_incident_cannot_be_closed_again(client):
    incident_id = report(client)
    post(client, f"/api/incidents/{incident_id}/resolve")

    response = post(client, f"/api/incidents/{incident_id}/false")

    assert response.status_code == 409
    assert response.json()["detail"] == "Сигналът вече е приключен"


def test_citizen_cannot_assign(client):
    incident_id = report(client)

    response = client.post(
        f"/api/incidents/{incident_id}/assign",
        json={"team_id": team_id("medical")},
        headers=auth(login(client, "citizen2")),
    )

    assert response.status_code == 403


def test_trust_stays_within_limits():
    user = User(trust=95)
    adjust_trust(user, 10)
    assert user.trust == 100
    adjust_trust(user, -150)
    assert user.trust == 0
