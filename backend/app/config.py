from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent

# Hosting providers such as Render give "postgres://..." or "postgresql://...".
# SQLAlchemy needs the driver in the URL, and this project uses psycopg 3.
_POSTGRES_PREFIXES = ("postgres://", "postgresql://")
_PSYCOPG_PREFIX = "postgresql+psycopg://"


class Settings(BaseSettings):
    """Application settings, read from environment variables and backend/.env."""

    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    database_url: str = "postgresql+psycopg://vigora:vigora@localhost:5432/vigora"
    # Development default, so the project starts without a .env file.
    secret_key: str = "change-me-to-a-long-random-text-at-least-32-chars"
    token_expire_hours: int = 12
    upload_dir: Path = BACKEND_DIR / "uploads"
    max_photo_mb: int = 5
    report_limit_count: int = 5
    report_limit_minutes: int = 10
    seed_demo_data: bool = True
    frontend_dir: Path = PROJECT_DIR / "frontend"

    # Web Push for witness questions when the app is closed. Empty keys = push is off.
    # Generate a pair with: python -m scripts.vapid_keys
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    # Contact address the push services can use if something goes wrong.
    vapid_subject: str = "mailto:admin@example.com"

    @field_validator("database_url")
    @classmethod
    def use_psycopg_driver(cls, url: str) -> str:
        """Turn a provider's postgres:// or postgresql:// URL into postgresql+psycopg://."""
        for prefix in _POSTGRES_PREFIXES:
            if url.startswith(prefix):
                return _PSYCOPG_PREFIX + url[len(prefix):]
        return url


settings = Settings()
