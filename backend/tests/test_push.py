"""Tests for Web Push: subscriptions, when a push is sent, and what it contains."""

import base64
import json
import time
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException
from sqlalchemy import select

from app.config import settings
from app.models import PushSubscription
from app.services import push
from scripts.vapid_keys import generate
from tests.conftest import NEAR, POINT, auth, login, send_report, share_location

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
KEYS = {"p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", "auth": "tBHItJI5svbpez7KI4CCXg"}


@pytest.fixture
def push_on(monkeypatch):
    """Turn push on with a fresh key pair."""
    public, private = generate()
    monkeypatch.setattr(settings, "vapid_public_key", public)
    monkeypatch.setattr(settings, "vapid_private_key", private)
    return public


@pytest.fixture
def queued(monkeypatch):
    """Record pushes instead of sending them."""
    calls = []
    monkeypatch.setattr(push, "queue", lambda user_id, payload: calls.append((user_id, payload)))
    return calls


def user_id(client, token):
    return client.get("/api/auth/me", headers=auth(token)).json()["id"]


def subscribe(client, token, endpoint=ENDPOINT):
    return client.post(
        "/api/push/subscribe", json={"endpoint": endpoint, "keys": KEYS}, headers=auth(token)
    )


def wait_until_disconnected(user):
    from app.realtime import manager

    # The server handles the close on its own thread a moment later.
    deadline = time.monotonic() + 2
    while manager.is_connected(user) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not manager.is_connected(user)


def subscriptions(db_session):
    return db_session.scalars(select(PushSubscription)).all()


# ---------- Key ----------


def test_key_when_push_is_off(client):
    assert client.get("/api/push/key").json() == {"enabled": False, "public_key": None}


def test_key_when_push_is_on(client, push_on):
    assert client.get("/api/push/key").json() == {"enabled": True, "public_key": push_on}


def test_generated_keys_work_with_pywebpush():
    public, private = generate()

    vapid = Vapid.from_string(private)
    raw_public = vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    assert base64.urlsafe_b64encode(raw_public).rstrip(b"=").decode() == public


# ---------- Subscribe and unsubscribe ----------


def test_subscribe_saves_the_browser(client, push_on):
    from app.database import SessionLocal

    token = login(client, "citizen1")

    response = subscribe(client, token)

    assert response.status_code == 200
    assert response.json() == {"subscribed": True}
    with SessionLocal() as db:
        [saved] = subscriptions(db)
        assert saved.endpoint == ENDPOINT
        assert saved.user_id == user_id(client, token)
        assert (saved.p256dh, saved.auth) == (KEYS["p256dh"], KEYS["auth"])


def test_subscribing_twice_keeps_one_row(client, push_on):
    from app.database import SessionLocal

    token = login(client, "citizen1")
    subscribe(client, token)
    subscribe(client, token)

    with SessionLocal() as db:
        assert len(subscriptions(db)) == 1


def test_browser_moves_to_the_next_user(client, push_on):
    from app.database import SessionLocal

    subscribe(client, login(client, "citizen1"))
    second = login(client, "citizen2")
    subscribe(client, second)

    with SessionLocal() as db:
        [saved] = subscriptions(db)
        assert saved.user_id == user_id(client, second)


def test_unsubscribe_removes_the_browser(client, push_on):
    from app.database import SessionLocal

    token = login(client, "citizen1")
    subscribe(client, token)

    response = client.request(
        "DELETE", "/api/push/subscribe", json={"endpoint": ENDPOINT}, headers=auth(token)
    )

    assert response.status_code == 200
    assert response.json() == {"subscribed": False}
    with SessionLocal() as db:
        assert subscriptions(db) == []


def test_unsubscribe_only_removes_own_browser(client, push_on):
    from app.database import SessionLocal

    subscribe(client, login(client, "citizen1"))
    other = login(client, "citizen2")

    client.request("DELETE", "/api/push/subscribe", json={"endpoint": ENDPOINT}, headers=auth(other))

    with SessionLocal() as db:
        assert len(subscriptions(db)) == 1


def test_subscribe_needs_citizen(client, push_on):
    assert subscribe(client, login(client, "operator")).status_code == 403
    assert client.post("/api/push/subscribe", json={"endpoint": ENDPOINT, "keys": KEYS}).status_code == 401


def test_subscribe_when_push_is_off(client):
    response = subscribe(client, login(client, "citizen1"))

    assert response.status_code == 503


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/abc",  # not https
        "https://example.com/push",  # not a push service
        "https://fcm.googleapis.com.evil.com/x",  # look-alike host
        "https://127.0.0.1/internal",
    ],
)
def test_only_known_push_services_are_accepted(client, push_on, endpoint):
    response = subscribe(client, login(client, "citizen1"), endpoint=endpoint)

    assert response.status_code == 422
    assert response.json()["detail"] == "Неподдържан адрес за известия"


# ---------- When a push is sent ----------


def test_no_push_when_connected(client, push_on, queued):
    witness = login(client, "citizen2")
    subscribe(client, witness)

    with client.websocket_connect(f"/ws?token={witness}") as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, *NEAR)

        response = send_report(client, login(client, "citizen1"), "medical", POINT)
        assert response.json()["witnesses_asked"] == 1

        # The question arrives over the open WebSocket instead.
        ws.send_json({"type": "ping"})
        events = []
        while (message := ws.receive_json())["event"] != "pong":
            events.append(message["event"])
        assert "witness.question" in events

    assert queued == []


def test_push_when_app_is_closed(client, push_on, queued):
    witness = login(client, "citizen2")
    witness_id = user_id(client, witness)
    subscribe(client, witness)

    with client.websocket_connect(f"/ws?token={witness}") as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, *NEAR)
    wait_until_disconnected(witness_id)

    response = send_report(client, login(client, "citizen1"), "medical", POINT)

    assert response.json()["witnesses_asked"] == 1
    [(sent_to, payload)] = queued
    assert sent_to == witness_id
    assert set(payload) == {"title", "body", "url", "tag"}
    assert payload["url"] == "/citizen/"
    assert payload["body"].startswith("Наблизо е подаден сигнал: медицински случай.")


def test_push_never_contains_the_location(client, push_on, queued):
    witness = login(client, "citizen2")
    subscribe(client, witness)
    with client.websocket_connect(f"/ws?token={witness}") as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, *NEAR)
    wait_until_disconnected(user_id(client, witness))

    send_report(client, login(client, "citizen1"), "medical", POINT)

    text = json.dumps(queued, ensure_ascii=False)
    for forbidden in ("lat", "lng", "distance", "42.69", "23.32"):
        assert forbidden not in text


def test_location_is_deleted_on_close_without_subscription(client, push_on, queued):
    from app.database import utcnow
    from app.realtime import manager

    witness = login(client, "citizen2")
    with client.websocket_connect(f"/ws?token={witness}") as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, *NEAR)
    wait_until_disconnected(user_id(client, witness))

    assert manager.locations.fresh(utcnow()) == {}
    assert send_report(client, login(client, "citizen1"), "medical", POINT).json()["witnesses_asked"] == 0
    assert queued == []


# ---------- Sending ----------


def add_subscription(client, push_on_key, username="citizen2"):
    from app.database import SessionLocal

    token = login(client, username)
    subscribe(client, token)
    return user_id(client, token), SessionLocal


@pytest.mark.parametrize("status", [404, 410])
def test_gone_subscriptions_are_removed(client, push_on, monkeypatch, status):
    witness_id, SessionLocal = add_subscription(client, push_on)

    def gone(**kwargs):
        raise WebPushException("gone", response=SimpleNamespace(status_code=status))

    monkeypatch.setattr(push, "webpush", gone)

    assert push.send_to_user(witness_id, {"title": "t", "body": "b", "url": "/citizen/", "tag": "x"}) == 0
    with SessionLocal() as db:
        assert subscriptions(db) == []


def test_other_failures_keep_the_subscription(client, push_on, monkeypatch):
    witness_id, SessionLocal = add_subscription(client, push_on)

    def busy(**kwargs):
        raise WebPushException("busy", response=SimpleNamespace(status_code=503))

    monkeypatch.setattr(push, "webpush", busy)

    assert push.send_to_user(witness_id, {"title": "t", "body": "b", "url": "/citizen/", "tag": "x"}) == 0
    with SessionLocal() as db:
        assert len(subscriptions(db)) == 1


def test_send_uses_the_vapid_key_and_expires_with_the_question(client, push_on, monkeypatch):
    witness_id, _ = add_subscription(client, push_on)
    calls = []
    monkeypatch.setattr(push, "webpush", lambda **kwargs: calls.append(kwargs))
    payload = {"title": "t", "body": "Въпрос", "url": "/citizen/", "tag": "witness-1"}

    assert push.send_to_user(witness_id, payload) == 1

    [call] = calls
    assert call["subscription_info"] == {"endpoint": ENDPOINT, "keys": KEYS}
    assert json.loads(call["data"]) == payload
    assert call["vapid_private_key"] == settings.vapid_private_key
    assert call["ttl"] == 600
