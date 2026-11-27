import pytest

from app.config import Settings


@pytest.mark.parametrize(
    "given",
    [
        "postgres://user:pass@db.example.com:5432/vigora",
        "postgresql://user:pass@db.example.com:5432/vigora",
        "postgresql+psycopg://user:pass@db.example.com:5432/vigora",
    ],
)
def test_postgres_urls_use_psycopg(given):
    settings = Settings(database_url=given)

    assert settings.database_url == "postgresql+psycopg://user:pass@db.example.com:5432/vigora"


def test_url_from_environment_is_converted(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@host/db?sslmode=require")

    assert Settings().database_url == "postgresql+psycopg://u:p@host/db?sslmode=require"


def test_sqlite_url_is_unchanged():
    assert Settings(database_url="sqlite:///./vigora.db").database_url == "sqlite:///./vigora.db"
