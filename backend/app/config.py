from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent


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


settings = Settings()
