"""Tests for the operator stats, protected photos and the demo reset."""

from sqlalchemy import select

from app.config import settings
from app.database import SessionLocal
from app.models import Team, User
from tests.conftest import FAR, NEAR, auth, login, send_report


def operator(client):
    return auth(login(client, "operator"))


def test_stats_count_open_and_confirmed(client):
    send_report(client, login(client, "citizen1"), "medical")
    send_report(client, login(client, "citizen2"), "medical", NEAR)  # merged: confirms the first
    fire_id = send_report(client, login(client, "citizen3"), "fire", FAR).json()["incident_id"]
    client.post(f"/api/incidents/{fire_id}/false", headers=operator(client))

    response = client.get("/api/stats", headers=operator(client))

    assert response.status_code == 200
    body = response.json()
    assert body["open"] == 1
    assert body["confirmed"] == 1
    assert body["total_24h"] == 2
    assert body["merged_reports_24h"] == 1
    assert body["avg_seconds_to_confirmation"] is not None
    assert body["avg_seconds_to_assignment"] is None
    assert (body["teams_available"], body["teams_total"]) == (6, 6)


def test_citizen_cannot_see_stats(client):
    response = client.get("/api/stats", headers=auth(login(client, "citizen1")))

    assert response.status_code == 403


def test_citizen_cannot_see_photos(client):
    response = client.get("/api/photos/anything.png", headers=auth(login(client, "citizen1")))

    assert response.status_code == 403


def test_hidden_name_is_rejected(client):
    response = client.get("/api/photos/..secret", headers=operator(client))

    assert response.status_code == 400
    assert response.json()["detail"] == "Невалидно име"


def test_missing_photo_is_not_found(client):
    response = client.get("/api/photos/missing.png", headers=operator(client))

    assert response.status_code == 404


def test_team_can_see_photo(client):
    (settings.upload_dir / "test-photo.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")

    response = client.get("/api/photos/test-photo.png", headers=auth(login(client, "med1")))

    assert response.status_code == 200
    assert response.content.startswith(b"\x89PNG")


def test_demo_reset_empties_incidents(client):
    citizen = login(client, "citizen1")
    incident_id = send_report(client, citizen, "medical").json()["incident_id"]
    with SessionLocal() as db:
        team_id = db.scalar(select(Team.id).where(Team.kind == "medical"))
    client.post(
        f"/api/incidents/{incident_id}/assign", json={"team_id": team_id}, headers=operator(client)
    )
    send_report(client, citizen, "fire", FAR)
    client.post(f"/api/incidents/{incident_id}/false", headers=operator(client))

    response = client.post("/api/demo/reset", headers=operator(client))

    assert response.status_code == 200
    assert client.get("/api/incidents", params={"scope": "all"}, headers=operator(client)).json() == []
    with SessionLocal() as db:
        assert {t.status for t in db.scalars(select(Team))} == {"available"}
        assert {u.trust for u in db.scalars(select(User))} == {50}
    # The accounts still work.
    assert send_report(client, citizen, "medical").status_code == 201


def test_citizen_cannot_reset(client):
    response = client.post("/api/demo/reset", headers=auth(login(client, "citizen1")))

    assert response.status_code == 403
