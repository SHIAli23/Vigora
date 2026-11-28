"""Reports sent by citizens."""

from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notify
from app.config import settings
from app.database import get_db, utcnow
from app.deps import require_role
from app.models import CITIZEN, Report, User
from app.realtime import manager
from app.rules import INCIDENT_TYPES, get_type
from app.services.geo import is_valid_point
from app.services.incidents import STATUS_LABELS, add_event, iso, submit_report
from app.services.photos import known_hashes, record_photo_check, save_photo
from app.services.ratelimit import RateLimiter
from app.services.witnesses import create_requests, find_witnesses

router = APIRouter(prefix="/api/reports", tags=["reports"])

limiter = RateLimiter(settings.report_limit_count, settings.report_limit_minutes)


def _asked_text(count: int) -> str:
    if count == 1:
        return "Изпратен въпрос до 1 човек наблизо"
    return f"Изпратен въпрос до {count} души наблизо"


@router.post("", status_code=status.HTTP_201_CREATED)
async def send_report(
    type: str = Form(...),
    lat: float = Form(...),
    lng: float = Form(...),
    description: str = Form("", max_length=500),
    people_affected: int = Form(0, ge=0, le=100),
    photo: UploadFile | None = File(None),
    user: User = Depends(require_role(CITIZEN)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if type not in INCIDENT_TYPES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Непознат тип сигнал")
    if not is_valid_point(lat, lng):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Невалидно местоположение")

    now = utcnow()
    # Checked before the photo is saved, so a flood of reports cannot fill the disk.
    if not limiter.allow(user.id, now):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Твърде много сигнали. Опитайте след малко."
        )

    saved = await save_photo(photo, lat, lng, now, known_hashes(db))
    photo_name = saved[0] if saved else None
    if saved:
        record_photo_check(db, *saved, now)
    report, incident, is_new = submit_report(
        db, user, type, lat, lng, description, people_affected, photo_name, now
    )
    requests = []
    if is_new:
        witnesses = find_witnesses(incident, manager.locations.fresh(now), {user.id})
        requests = create_requests(db, incident, witnesses, now)
        if requests:
            add_event(incident, _asked_text(len(requests)), now)
    db.commit()

    await notify.incident_changed(
        incident, now, event="incident.created" if is_new else "incident.updated"
    )
    await notify.witness_questions(incident, requests)

    return {
        "report_id": report.id,
        "incident_id": incident.id,
        "merged": not is_new,
        "witnesses_asked": len(requests),
        "status": incident.status,
        "status_label": STATUS_LABELS[incident.status],
    }


@router.get("/mine")
def my_reports(
    user: User = Depends(require_role(CITIZEN)),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """The citizen's last 20 reports, newest first, with the current status of each incident."""
    reports = db.scalars(
        select(Report).where(Report.user_id == user.id).order_by(Report.id.desc()).limit(20)
    ).all()
    return [
        {
            "id": report.id,
            "incident_id": report.incident_id,
            "type": report.type,
            "type_label": get_type(report.type).label,
            "description": report.description,
            "status": report.incident.status,
            "status_label": STATUS_LABELS[report.incident.status],
            "confirmations": (report.incident.reports_count - 1) + report.incident.witness_yes,
            "created_at": iso(report.created_at),
        }
        for report in reports
    ]
