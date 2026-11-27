from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import Base, SessionLocal, engine
from app.routers import auth, incidents, meta, push, reports, teams, witness, ws
from app.seed import seed_demo_data


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Create all database tables and the demo data when the server starts."""
    Base.metadata.create_all(bind=engine)
    if settings.seed_demo_data:
        with SessionLocal() as db:
            seed_demo_data(db)
    yield


app = FastAPI(
    title="Vigora API",
    description="Прототип на система за подаване на сигнали към 112.",
    lifespan=lifespan,
)

app.include_router(auth.router)
app.include_router(reports.router)
app.include_router(incidents.router)
app.include_router(teams.router)
app.include_router(meta.router)
app.include_router(witness.router)
app.include_router(push.router)
app.include_router(ws.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def home() -> Response:
    """The home page with links to the three apps, or the API docs if there is no frontend."""
    index = settings.frontend_dir / "index.html"
    if index.is_file():
        return FileResponse(index)
    return RedirectResponse("/docs")


# The frontends are plain files. A folder that does not exist is skipped, so the API also
# runs without them. Mounted last, so they never hide an API route.
for _folder in ("shared", "citizen", "operator", "team"):
    _path = settings.frontend_dir / _folder
    if _path.is_dir():
        app.mount(f"/{_folder}", StaticFiles(directory=_path, html=True), name=_folder)
