"""Shared test fixtures and helpers. Tests run on a temporary SQLite database, never PostgreSQL."""

import os
import tempfile

# Must run before anything from app is imported, because app.config reads these on import.
_TEMP_DIR = tempfile.mkdtemp(prefix="vigora-tests-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_TEMP_DIR, 'test.db')}"
os.environ["UPLOAD_DIR"] = os.path.join(_TEMP_DIR, "uploads")
os.environ["SECRET_KEY"] = "test-secret-key-that-is-long-enough-for-hs256-signing"
os.makedirs(os.environ["UPLOAD_DIR"], exist_ok=True)

from collections.abc import Generator  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.seed import seed_demo_data  # noqa: E402

# A point in central Sofia, one about 100 m north of it, and one about 5.5 km north of it.
POINT = (42.6955, 23.3290)
NEAR = (42.6964, 23.3290)
FAR = (42.7455, 23.3290)

TEAM_USERNAMES = ("med1", "med2", "fire1", "fire2", "police1", "police2")


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    """A test client on a fresh database with the demo data."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        seed_demo_data(db)

    # Imported here, so unit tests that do not use the API do not load it.
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def db() -> Generator[Session, None, None]:
    """A database session on the test database."""
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        yield session


def password_for(username: str) -> str:
    if username == "operator":
        return "operator123"
    if username in TEAM_USERNAMES:
        return "team123"
    return "citizen123"


def login(client: TestClient, username: str) -> str:
    """Log in as a demo user and return the access token."""
    response = client.post(
        "/api/auth/login",
        json={"username": username, "password": password_for(username)},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def auth(token: str) -> dict[str, str]:
    """The Authorization header for a token."""
    return {"Authorization": f"Bearer {token}"}


def send_report(client, token, type_="medical", point=POINT, **extra):
    """Send a report as form data. Pass photo=(name, bytes, content_type) to attach a photo."""
    photo = extra.pop("photo", None)
    data = {"type": type_, "lat": point[0], "lng": point[1], **extra}
    files = {"photo": photo} if photo else None
    return client.post("/api/reports", data=data, files=files, headers=auth(token))
