"""Web Push: witness questions for citizens whose app is closed.

Privacy:
- A push carries only the question text and a link to /citizen/. Never the incident's
  location or the distance.
- The content is encrypted for the citizen's browser; the push service only passes it on.
- A citizen with witness mode on and a subscription keeps their rounded location for at most
  LOCATION_MAX_AGE_MIN after it was last sent, even if the app closes. Without a
  subscription the location is deleted when the app closes, as before.
"""

import asyncio
import json
import logging
from typing import Any
from urllib.parse import urlsplit

from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import PushSubscription
from app.rules import WITNESS_ANSWER_WINDOW_MIN

log = logging.getLogger(__name__)

# The server sends a request to every saved endpoint, so only the browsers' own push services
# are accepted. Otherwise an account could make the server call any address.
ALLOWED_PUSH_HOSTS = (
    "fcm.googleapis.com",  # Chrome, Edge on Android, Samsung Internet, Opera
    "android.googleapis.com",
    "push.services.mozilla.com",  # Firefox
    "notify.windows.com",  # Edge on Windows
    "push.apple.com",  # Safari
)

# Subscriptions the push service says no longer exist.
GONE_STATUSES = (404, 410)

CITIZEN_URL = "/citizen/"

_tasks: set[asyncio.Task] = set()


def push_enabled() -> bool:
    return bool(settings.vapid_public_key and settings.vapid_private_key)


def is_allowed_endpoint(endpoint: str) -> bool:
    """True for an https address of a known browser push service."""
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host:
        return False
    return any(host == allowed or host.endswith("." + allowed) for allowed in ALLOWED_PUSH_HOSTS)


# ---------- Subscriptions ----------


def save_subscription(db: Session, user_id: int, endpoint: str, p256dh: str, auth: str) -> None:
    """Add or update a subscription. A browser used by a new user moves to that user."""
    subscription = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
    if subscription is None:
        db.add(PushSubscription(user_id=user_id, endpoint=endpoint, p256dh=p256dh, auth=auth))
    else:
        subscription.user_id = user_id
        subscription.p256dh = p256dh
        subscription.auth = auth
    db.flush()


def remove_subscription(db: Session, user_id: int, endpoint: str) -> None:
    """Remove the user's subscription for this browser, if there is one."""
    db.execute(
        delete(PushSubscription).where(
            PushSubscription.user_id == user_id, PushSubscription.endpoint == endpoint
        )
    )


def has_subscription(user_id: int) -> bool:
    with SessionLocal() as db:
        return (
            db.scalar(select(PushSubscription.id).where(PushSubscription.user_id == user_id).limit(1))
            is not None
        )


def keeps_location_after_close(user_id: int) -> bool:
    """Whether a citizen's shared location is kept when their app closes: only if push is on
    and they allowed notifications. The location still expires after LOCATION_MAX_AGE_MIN."""
    return push_enabled() and has_subscription(user_id)


# ---------- Sending ----------


def question_payload(question: dict[str, Any]) -> dict[str, Any]:
    """What the notification shows. Built from the question, but only the text: no location,
    no distance, no incident details beyond the question itself."""
    return {
        "title": "Vigora: въпрос от 112",
        "body": question["question"],
        "url": CITIZEN_URL,
        "tag": f"witness-{question['request_id']}",
    }


def send_to_user(user_id: int, payload: dict[str, Any]) -> int:
    """Send the payload to every browser of the user. Returns how many were sent.

    Subscriptions that the push service reports as gone (404/410) are deleted. Runs in a
    worker thread, so it uses its own database session.
    """
    sent = 0
    data = json.dumps(payload, ensure_ascii=False)
    with SessionLocal() as db:
        subscriptions = db.scalars(
            select(PushSubscription).where(PushSubscription.user_id == user_id)
        ).all()
        for subscription in subscriptions:
            try:
                webpush(
                    subscription_info={
                        "endpoint": subscription.endpoint,
                        "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                    },
                    data=data,
                    vapid_private_key=settings.vapid_private_key,
                    # A new dict each time: webpush adds fields to it.
                    vapid_claims={"sub": settings.vapid_subject},
                    # The question can only be answered for this long.
                    ttl=WITNESS_ANSWER_WINDOW_MIN * 60,
                    headers={"Urgency": "high"},
                    timeout=10,
                )
                sent += 1
            except WebPushException as error:
                status = getattr(error.response, "status_code", None)
                if status in GONE_STATUSES:
                    db.delete(subscription)
                else:
                    log.warning("Push to user %s failed: %s", user_id, status or error)
            except Exception as error:  # noqa: BLE001 - one bad browser must not stop the rest
                log.warning("Push to user %s failed: %s", user_id, type(error).__name__)
        db.commit()
        remaining = db.scalar(
            select(PushSubscription.id).where(PushSubscription.user_id == user_id).limit(1)
        )

    if remaining is None:
        _forget_unreachable_location(user_id)
    return sent


def _forget_unreachable_location(user_id: int) -> None:
    """A citizen with no app open and no working subscription cannot be asked: drop the location."""
    from app.realtime import manager  # imported here: realtime imports this module's users

    if not manager.is_connected(user_id):
        manager.locations.remove(user_id)


def queue(user_id: int, payload: dict[str, Any]) -> None:
    """Send in the background, so a slow push service never delays the citizen who reported."""
    if not push_enabled():
        return
    task = asyncio.get_running_loop().create_task(asyncio.to_thread(send_to_user, user_id, payload))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
