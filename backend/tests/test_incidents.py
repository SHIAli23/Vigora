"""Tests for the operator's incident list and detail."""

from app.database import SessionLocal, utcnow
from app.models import STATUS_RESOLVED, Incident
from tests.conftest import auth, login, send_report


def incidents(client, token, **params):
    return client.get("/api/incidents", params=params, headers=auth(token))


def test_list_is_sorted_by_urgency(client):
    citizen = login(client, "citizen1")
    send_report(client, citizen, "other")
    send_report(client, citizen, "medical", people_affected=3)
    send_report(client, citizen, "fire")

    response = incidents(client, login(client, "operator"))

    assert response.status_code == 200
    body = response.json()
    assert [i["type"] for i in body] == ["medical", "fire", "other"]
    scores = [i["urgency"] for i in body]
    assert scores == sorted(scores, reverse=True)


def test_scope_separates_open_and_closed(client):
    citizen = login(client, "citizen1")
    open_id = send_report(client, citizen, "medical").json()["incident_id"]
    closed_id = send_report(client, citizen, "fire").json()["incident_id"]
    with SessionLocal() as db:
        incident = db.get(Incident, closed_id)
        incident.status = STATUS_RESOLVED
        incident.closed_at = utcnow()
        db.commit()
    operator = login(client, "operator")

    assert [i["id"] for i in incidents(client, operator).json()] == [open_id]
    assert [i["id"] for i in incidents(client, operator, scope="closed").json()] == [closed_id]
    assert {i["id"] for i in incidents(client, operator, scope="all").json()} == {
        open_id,
        closed_id,
    }
    assert incidents(client, operator, scope="nope").status_code == 422


def test_citizen_cannot_list_incidents(client):
    response = incidents(client, login(client, "citizen1"))

    assert response.status_code == 403


def test_incident_detail(client):
    incident_id = send_report(client, login(client, "citizen1"), "medical").json()["incident_id"]

    response = client.get(f"/api/incidents/{incident_id}", headers=auth(login(client, "operator")))

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == incident_id
    assert len(body["reports"]) == 1
    assert body["events"]


def test_unknown_incident_is_not_found(client):
    response = client.get("/api/incidents/999999", headers=auth(login(client, "operator")))

    assert response.status_code == 404
    assert response.json()["detail"] == "Сигналът не е намерен"
