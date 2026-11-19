"""Tests for the WebSocket real-time endpoint."""

import time

import pytest
from starlette.websockets import WebSocketDisconnect

from app.security import create_token
from tests.conftest import login


def test_valid_token_gets_hello(client):
    token = login(client, "operator")
    with client.websocket_connect(f"/ws?token={token}") as ws:
        assert ws.receive_json() == {"event": "hello", "data": {"role": "operator"}}


def test_ping_gets_pong(client):
    token = login(client, "citizen1")
    with client.websocket_connect(f"/ws?token={token}") as ws:
        assert ws.receive_json()["event"] == "hello"
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"event": "pong", "data": {}}


def test_invalid_token_is_rejected(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws?token=not-a-real-token") as ws:
            ws.receive_json()
    assert exc.value.code == 1008


def test_unknown_user_is_rejected(client):
    token = create_token(999999, "citizen")
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws?token={token}") as ws:
            ws.receive_json()
    assert exc.value.code == 1008


def test_connection_is_removed_after_disconnect(client):
    from app.realtime import manager

    token = login(client, "operator")
    with client.websocket_connect(f"/ws?token={token}") as ws:
        ws.receive_json()
        assert manager.online_count().get("operator") == 1

    # The server removes the connection on its own thread after the client closes, so wait for it.
    deadline = time.monotonic() + 2
    while manager.online_count().get("operator", 0) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert manager.online_count().get("operator", 0) == 0
