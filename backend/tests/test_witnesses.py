"""Tests for keeping witness locations in memory."""

import time
from datetime import datetime, timedelta

from app.database import utcnow
from app.rules import LOCATION_MAX_AGE_MIN
from app.services.witnesses import LocationStore
from tests.conftest import login, share_location

NOW = datetime(2026, 1, 1, 12, 0)


def connect_witness(client, username="citizen1"):
    token = login(client, username)
    return client.websocket_connect(f"/ws?token={token}")


def test_stored_location_is_rounded_to_3_decimals(client):
    from app.realtime import manager

    with connect_witness(client) as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, 42.695512, 23.329049)
        locations = manager.locations.fresh(utcnow())

    assert len(locations) == 1
    location = next(iter(locations.values()))
    assert (location.lat, location.lng) == (42.696, 23.329)


def test_location_is_removed_after_socket_closes(client):
    from app.realtime import manager

    with connect_witness(client) as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, 42.6955, 23.3290)
        assert manager.locations.fresh(utcnow())

    # The server handles the close on its own thread a moment later, so wait for it.
    deadline = time.monotonic() + 2
    while manager.locations.fresh(utcnow()) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert manager.locations.fresh(utcnow()) == {}


def test_location_off_removes_location(client):
    from app.realtime import manager

    with connect_witness(client) as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, 42.6955, 23.3290)
        ws.send_json({"type": "location_off"})
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["event"] == "pong"
        assert manager.locations.fresh(utcnow()) == {}


def test_invalid_location_is_ignored(client):
    from app.realtime import manager

    with connect_witness(client) as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, 91, 23.3290)
        share_location(ws, "42.6955", 23.3290)
        share_location(ws, True, 23.3290)
        assert manager.locations.fresh(utcnow()) == {}


def test_operator_location_is_ignored(client):
    from app.realtime import manager

    with connect_witness(client, "operator") as ws:
        assert ws.receive_json()["event"] == "hello"
        share_location(ws, 42.6955, 23.3290)
        assert manager.locations.fresh(utcnow()) == {}


def test_old_locations_expire():
    store = LocationStore()
    store.update(1, 42.6955, 23.3290, NOW - timedelta(minutes=LOCATION_MAX_AGE_MIN, seconds=1))
    store.update(2, 42.6955, 23.3290, NOW - timedelta(minutes=LOCATION_MAX_AGE_MIN - 1))

    assert set(store.fresh(NOW)) == {2}
    # The expired entry is deleted, not just hidden.
    assert set(store.fresh(NOW - timedelta(hours=1))) == {2}


def test_fresh_returns_a_copy():
    store = LocationStore()
    store.update(1, 42.6955, 23.3290, NOW)
    store.fresh(NOW).clear()
    assert set(store.fresh(NOW)) == {1}
