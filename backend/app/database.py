from collections.abc import Generator
from datetime import datetime, timezone

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    """Parent class of all database models."""


def make_engine(url: str) -> Engine:
    """Create a database engine with the right options for SQLite or PostgreSQL."""
    if url.startswith("sqlite"):
        # FastAPI can use one SQLite connection from different threads.
        return create_engine(url, connect_args={"check_same_thread": False})
    # pool_pre_ping replaces connections that the database has closed.
    return create_engine(url, pool_pre_ping=True)


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency: gives a request its own session and closes it afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utcnow() -> datetime:
    """Return the current UTC time without tzinfo, as it is stored in the database."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
