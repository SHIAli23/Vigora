"""Tests for pushing incident changes over WebSocket."""

import asyncio

from app import notify
from app.models import Team
from app.realtime import manager
from tests.conftest import NEAR, POINT, login, send_report


def test_operator_gets_created_then_updated_incident(client):
    operator = login(client, "operator")
    with client.websocket_connect(f"/ws?token={operator}") as ws:
        assert ws.receive_json()["event"] == "hello"

        response = send_report(client, login(client, "citizen1"), point=POINT)
        assert response.status_code == 201, response.text
        created = ws.receive_json()
        assert created["event"] == "incident.created"
        assert created["data"]["id"] == response.json()["incident_id"]
        assert isinstance(created["data"]["urgency"], int)
        assert created["data"]["reports_count"] == 1
        assert "sent_at" in created

        response = send_report(client, login(client, "citizen2"), point=NEAR)
        assert response.status_code == 201, response.text
        assert response.json()["merged"] is True
        updated = ws.receive_json()
        assert updated["event"] == "incident.updated"
        assert updated["data"]["id"] == created["data"]["id"]
        assert updated["data"]["reports_count"] == 2


def test_reporter_gets_status_without_urgency(client):
    citizen = login(client, "citizen1")
    with client.websocket_connect(f"/ws?token={citizen}") as ws:
        assert ws.receive_json()["event"] == "hello"

        response = send_report(client, citizen)
        assert response.status_code == 201, response.text
        message = ws.receive_json()
        assert message["event"] == "report.status"
        assert message["data"] == {
            "incident_id": response.json()["incident_id"],
            "status": "new",
            "status_label": response.json()["status_label"],
        }


def test_team_changed_sends_team_view_to_operators(monkeypatch):
    sent = []

    async def fake_to_operators(event, data):
        sent.append((event, data))

    monkeypatch.setattr(manager, "to_operators", fake_to_operators)
    team = Team(id=7, name="Линейка 1", kind="medical", lat=42.7, lng=23.3, status="available")
    asyncio.run(notify.team_changed(team))

    assert sent == [
        (
            "team.updated",
            {
                "id": 7,
                "name": "Линейка 1",
                "kind": "medical",
                "kind_label": "Медицински екип",
                "lat": 42.7,
                "lng": 23.3,
                "status": "available",
                "current_incident_id": None,
            },
        )
    ]
