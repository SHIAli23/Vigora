"""Tests for witnesses answering a question about a nearby incident."""

from datetime import timedelta

from app.database import SessionLocal, utcnow
from app.models import Incident, WitnessRequest
from app.services import reputation, urgency
from tests.conftest import NEAR, POINT, auth, login, send_report, share_location
from tests.test_witness import connect, witness_questions


def ask_witness(client, witness="citizen2"):
    """Report an incident with a witness nearby. Returns (request_id, incident_id, witness token)."""
    with connect(client, witness) as ws:
        share_location(ws, *NEAR)
        send_report(client, login(client, "citizen1"), "medical", POINT)
        question = witness_questions(ws)[0]
    return question["request_id"], question["incident_id"], login(client, witness)


def answer(client, token, request_id, value):
    return client.post(f"/api/witness/{request_id}", data={"answer": value}, headers=auth(token))


def urgency_of(incident_id):
    """The incident's urgency, at a fixed time so the waiting points do not change."""
    with SessionLocal() as db:
        incident = db.get(Incident, incident_id)
        result = urgency.calculate(
            incident, reputation.average_trust(incident), incident.created_at
        )
        confirmed = incident.reports_count > 1 or incident.witness_yes > 0
    return result.score, confirmed


def test_yes_raises_urgency_and_confirms(client):
    request_id, incident_id, token = ask_witness(client)
    before, confirmed_before = urgency_of(incident_id)

    response = answer(client, token, request_id, "yes")

    assert response.status_code == 200
    after, confirmed_after = urgency_of(incident_id)
    assert after - before == urgency.PER_CONFIRMATION == 8
    assert not confirmed_before
    assert confirmed_after


def test_pending_lists_question_until_answered(client):
    request_id, _, token = ask_witness(client)

    pending = client.get("/api/witness/pending", headers=auth(token)).json()
    assert [q["request_id"] for q in pending] == [request_id]

    answer(client, token, request_id, "no")
    assert client.get("/api/witness/pending", headers=auth(token)).json() == []


def test_answering_twice_is_rejected(client):
    request_id, _, token = ask_witness(client)
    assert answer(client, token, request_id, "yes").status_code == 200

    response = answer(client, token, request_id, "yes")

    assert response.status_code == 409
    assert response.json()["detail"] == "Вече сте отговорили"


def test_other_citizen_cannot_answer(client):
    request_id, _, _ = ask_witness(client)

    response = answer(client, login(client, "citizen3"), request_id, "yes")

    assert response.status_code == 409
    assert response.json()["detail"] == "Този въпрос не е изпратен до вас"


def test_late_answer_is_rejected(client):
    request_id, _, token = ask_witness(client)
    with SessionLocal() as db:
        db.get(WitnessRequest, request_id).asked_at = utcnow() - timedelta(minutes=30)
        db.commit()

    response = answer(client, token, request_id, "yes")

    assert response.status_code == 409
    assert response.json()["detail"] == "Времето за отговор изтече"


def test_unknown_request_is_not_found(client):
    response = answer(client, login(client, "citizen2"), 999999, "yes")

    assert response.status_code == 404
