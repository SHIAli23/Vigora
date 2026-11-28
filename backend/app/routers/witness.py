"""Questions sent to citizens near an incident, and their answers."""

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notify
from app.database import get_db, utcnow
from app.deps import require_role
from app.models import ANSWER_NO, ANSWER_YES, CITIZEN, OPEN_STATUSES, Incident, User, WitnessRequest
from app.rules import WITNESS_ANSWER_WINDOW_MIN
from app.services.incidents import add_event
from app.services.photos import known_hashes, record_photo_check, save_photo
from app.services.witnesses import AnswerError, check_answer, question_view, record_answer

router = APIRouter(prefix="/api/witness", tags=["witness"])


def _answer_text(answer: str, distance_m: float) -> str:
    if answer == ANSWER_YES:
        what = "потвърди"
    elif answer == ANSWER_NO:
        what = "не вижда нищо"
    else:
        what = "не вижда оттам"
    return f"Свидетел на {round(distance_m)} м {what}"


@router.get("/pending")
def pending_questions(
    user: User = Depends(require_role(CITIZEN)),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """The user's unanswered questions that have not expired, about incidents still open."""
    cutoff = utcnow() - timedelta(minutes=WITNESS_ANSWER_WINDOW_MIN)
    requests = db.scalars(
        select(WitnessRequest)
        .join(Incident)
        .where(
            WitnessRequest.user_id == user.id,
            WitnessRequest.answer.is_(None),
            WitnessRequest.asked_at >= cutoff,
            Incident.status.in_(OPEN_STATUSES),
        )
        .order_by(WitnessRequest.asked_at.desc())
    ).all()
    return [question_view(request) for request in requests]


@router.post("/{request_id}")
async def answer_question(
    request_id: int,
    answer: str = Form(...),
    photo: UploadFile | None = File(None),
    user: User = Depends(require_role(CITIZEN)),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    request = db.get(WitnessRequest, request_id)
    if request is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Въпросът не е намерен")

    now = utcnow()
    try:
        # Checked before the photo is saved, so a rejected answer leaves no file behind.
        check_answer(request, user.id, answer, now)
        saved = None
        if answer == ANSWER_YES:
            # A witness photo should show the incident, so it is compared with the incident's point.
            incident = request.incident
            saved = await save_photo(photo, incident.lat, incident.lng, now, known_hashes(db))
        photo_name = saved[0] if saved else None
        if saved:
            record_photo_check(db, *saved, now)
        incident = record_answer(request, user.id, answer, photo_name, now)
    except AnswerError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error

    add_event(incident, _answer_text(answer, request.distance_m), now)
    db.commit()

    await notify.incident_changed(incident, now)
    return {"request_id": request.id, "incident_id": incident.id, "answer": answer}
