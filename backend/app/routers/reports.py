"""Reports sent by citizens."""

from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.deps import require_role
from app.models import CITIZEN, Report, User
from app.rules import INCIDENT_TYPES, get_type
from app.services.geo import is_valid_point
from app.services.incidents import STATUS_LABELS, iso, submit_report
from app.services.photos import save_photo
from app.services.ratelimit import RateLimiter

router = APIRouter(prefix="/api/reports", tags=["reports"])

limiter = RateLimiter(settings.report_limit_count, settings.report_limit_minutes)


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

    photo_name = await save_photo(photo)
    report, incident, is_new = submit_report(
        db, user, type, lat, lng, description, people_affected, photo_name, now
    )
    db.commit()

    return {
        "report_id": report.id,
        "incident_id": incident.id,
        "merged": not is_new,
        "witnesses_asked": 0,
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
