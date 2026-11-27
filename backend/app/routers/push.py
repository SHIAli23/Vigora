"""Web Push subscriptions for citizens' witness questions."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import require_role
from app.models import CITIZEN, User
from app.schemas import PushSubscriptionIn, PushUnsubscribeIn
from app.services import push

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/key")
def public_key() -> dict[str, Any]:
    """The server's public VAPID key for subscribing. Public, no login needed."""
    enabled = push.push_enabled()
    return {"enabled": enabled, "public_key": settings.vapid_public_key if enabled else None}


@router.post("/subscribe")
def subscribe(
    body: PushSubscriptionIn,
    user: User = Depends(require_role(CITIZEN)),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    if not push.push_enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Известията не са настроени на сървъра")
    if not push.is_allowed_endpoint(body.endpoint):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Неподдържан адрес за известия")
    push.save_subscription(db, user.id, body.endpoint, body.keys.p256dh, body.keys.auth)
    db.commit()
    return {"subscribed": True}


@router.delete("/subscribe")
def unsubscribe(
    body: PushUnsubscribeIn,
    user: User = Depends(require_role(CITIZEN)),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    """Stop notifications for this browser. Answers the same if there was nothing to remove."""
    push.remove_subscription(db, user.id, body.endpoint)
    db.commit()
    return {"subscribed": False}
