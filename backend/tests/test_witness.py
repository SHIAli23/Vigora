"""Tests for asking nearby citizens to confirm a new incident."""

from contextlib import contextmanager

from tests.conftest import FAR, NEAR, POINT, login, send_report, share_location


@contextmanager
def connect(client, username):
    """Open a WebSocket for the user and read the hello message."""
    with client.websocket_connect(f"/ws?token={login(client, username)}") as ws:
        assert ws.receive_json()["event"] == "hello"
        yield ws


def events_until_pong(ws):
    """Send a ping and return the events received before the pong."""
    ws.send_json({"type": "ping"})
    events = []
    while (message := ws.receive_json())["event"] != "pong":
        events.append(message)
    return events


def witness_questions(ws):
    return [m["data"] for m in events_until_pong(ws) if m["event"] == "witness.question"]


def test_nearby_citizen_is_asked(client):
    reporter = login(client, "citizen1")
    with connect(client, "citizen2") as witness:
        share_location(witness, *NEAR)

        response = send_report(client, reporter, "medical", POINT)
        assert response.status_code == 201
        assert response.json()["witnesses_asked"] == 1

        questions = witness_questions(witness)
        assert len(questions) == 1
        question = questions[0]
        assert question["incident_id"] == response.json()["incident_id"]
        assert "От безопасно място" in question["question"]
        assert question["distance_m"] < 300
        assert question["violent"] is False
        assert question["expires_in_min"] > 0


def test_event_is_added_when_witnesses_are_asked(client):
    from app.database import SessionLocal
    from app.models import Incident

    reporter = login(client, "citizen1")
    with connect(client, "citizen2") as witness:
        share_location(witness, *NEAR)
        incident_id = send_report(client, reporter, "medical", POINT).json()["incident_id"]

    with SessionLocal() as db:
        texts = [event.text for event in db.get(Incident, incident_id).events]
    assert "Изпратен въпрос до 1 човек наблизо" in texts


def test_far_citizen_is_not_asked(client):
    reporter = login(client, "citizen1")
    with connect(client, "citizen2") as witness:
        share_location(witness, *FAR)

        response = send_report(client, reporter, "medical", POINT)
        assert response.json()["witnesses_asked"] == 0
        assert witness_questions(witness) == []


def test_reporter_is_not_asked_about_own_report(client):
    with connect(client, "citizen1") as reporter_ws:
        share_location(reporter_ws, *POINT)

        response = send_report(client, login(client, "citizen1"), "medical", POINT)
        assert response.json()["witnesses_asked"] == 0
        assert witness_questions(reporter_ws) == []


def test_merged_report_does_not_ask_again(client):
    first = login(client, "citizen1")
    send_report(client, first, "medical", POINT)

    with connect(client, "citizen3") as witness:
        share_location(witness, *NEAR)
        response = send_report(client, login(client, "citizen2"), "medical", NEAR)
        assert response.json()["merged"] is True
        assert response.json()["witnesses_asked"] == 0
        assert witness_questions(witness) == []


def test_violence_question_warns_to_stay_away(client):
    reporter = login(client, "citizen1")
    with connect(client, "citizen2") as witness:
        share_location(witness, *NEAR)
        send_report(client, reporter, "violence", POINT)

        question = witness_questions(witness)[0]
        assert question["question"].startswith("Не се приближавайте!")
        assert question["violent"] is True
