from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.database import Base, engine


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Create all database tables when the server starts."""
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="Vigora API",
    description="Прототип на система за подаване на сигнали към 112.",
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
