"""Reference data for the frontends, operator stats, protected photos and the demo reset."""

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.deps import require_role
from app.models import (
    OPEN_STATUSES,
    OPERATOR,
    TEAM,
    TEAM_AVAILABLE,
    Incident,
    IncidentEvent,
    Report,
    Team,
    User,
    WitnessRequest,
)
from app.realtime import manager
from app.rules import INCIDENT_TYPES, TEAM_KIND_LABELS
from app.services import reputation, urgency
from app.services.incidents import STATUS_LABELS
from app.services.reputation import NEUTRAL_TRUST

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/meta")
def meta() -> dict[str, Any]:
    """Public, no login needed."""
    return {
        "types": [
            {
                "key": t.key,
                "label": t.label,
                "color": t.color,
                "icon": t.icon,
                "life_threatening": t.life_threatening,
                "violent": t.violent,
            }
            for t in INCIDENT_TYPES.values()
        ],
        "team_kinds": [{"key": key, "label": label} for key, label in TEAM_KIND_LABELS.items()],
        "statuses": [{"key": key, "label": label} for key, label in STATUS_LABELS.items()],
    }


def _average_seconds(pairs: list[tuple[datetime, datetime | None]]) -> int | None:
    """The average time from start to end in whole seconds, skipping pairs with no end."""
    seconds = [(end - start).total_seconds() for start, end in pairs if end is not None]
    if not seconds:
        return None
    return round(sum(seconds) / len(seconds))


@router.get("/stats")
def stats(
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Numbers for the operator's dashboard, about the incidents of the last 24 hours."""
    now = utcnow()
    incidents = db.scalars(
        select(Incident).where(Incident.created_at >= now - timedelta(hours=24))
    ).all()
    open_incidents = [i for i in incidents if i.status in OPEN_STATUSES]
    critical = [
        i
        for i in open_incidents
        if urgency.calculate(i, reputation.average_trust(i), now).level == "critical"
    ]
    teams = db.scalars(select(Team)).all()
    return {
        "open": len(open_incidents),
        "critical": len(critical),
        "confirmed": sum(1 for i in incidents if i.reports_count > 1 or i.witness_yes > 0),
        "total_24h": len(incidents),
        "merged_reports_24h": sum(i.reports_count - 1 for i in incidents),
        "avg_seconds_to_confirmation": _average_seconds(
            [(i.created_at, i.first_confirmed_at) for i in incidents]
        ),
        "avg_seconds_to_assignment": _average_seconds(
            [(i.created_at, i.assigned_at) for i in incidents]
        ),
        "teams_available": sum(1 for t in teams if t.status == TEAM_AVAILABLE),
        "teams_total": len(teams),
        "online": manager.online_count(),
    }


@router.get("/photos/{name}")
def photo(name: str, user: User = Depends(require_role(OPERATOR, TEAM))) -> FileResponse:
    """A report or witness photo. Only operators and teams can see them."""
    # The name must be a plain file name inside the upload folder. ":" is also rejected,
    # because on Windows "C:name" would point outside the folder.
    if "/" in name or "\\" in name or ":" in name or name.startswith("."):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Невалидно име")
    path = settings.upload_dir / name
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Снимката не е намерена")
    return FileResponse(path)


@router.post("/demo/reset")
async def demo_reset(
    user: User = Depends(require_role(OPERATOR)),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """Delete all incidents and their data, and reset teams and trust. Accounts and teams stay."""
    # Imported here: the reports router is not needed by the rest of this module.
    from app.routers.reports import limiter

    db.execute(delete(IncidentEvent))
    db.execute(delete(WitnessRequest))
    db.execute(delete(Report))
    db.execute(delete(Incident))
    db.execute(update(Team).values(status=TEAM_AVAILABLE, current_incident_id=None))
    db.execute(update(User).values(trust=int(NEUTRAL_TRUST)))
    db.commit()
    limiter.reset()

    await manager.to_operators("demo.reset", {})
    return {"status": "ok"}
