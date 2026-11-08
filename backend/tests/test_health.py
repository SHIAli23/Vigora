from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok():
    # Without a "with" block the lifespan does not run, so no database is needed.
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
