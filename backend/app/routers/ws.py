"""WebSocket endpoint for real-time events. The login token is passed as a query parameter."""

import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from app.database import SessionLocal, utcnow
from app.models import CITIZEN, User
from app.realtime import Connection, manager
from app.security import decode_token
from app.services.geo import is_valid_point

router = APIRouter(tags=["realtime"])


def _is_number(value: object) -> bool:
    # bool is a subclass of int, but true/false is not a coordinate.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _handle_location(conn: Connection, message: dict) -> None:
    """Store or remove a citizen's shared location. Invalid points are ignored."""
    if message.get("type") == "location_off":
        manager.locations.remove(conn.user_id)
        return
    lat, lng = message.get("lat"), message.get("lng")
    if _is_number(lat) and _is_number(lng) and is_valid_point(lat, lng):
        manager.locations.update(conn.user_id, lat, lng, utcnow())


def _user_from_token(token: str) -> User | None:
    payload = decode_token(token)
    if payload is None:
        return None
    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        return None
    # A short-lived session, so no database connection is held while the socket is open.
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is not None:
            db.expunge(user)
        return user


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query("")) -> None:
    user = _user_from_token(token)
    if user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    conn = Connection(websocket=websocket, user_id=user.id, role=user.role, team_id=user.team_id)
    await manager.connect(conn)
    try:
        await websocket.send_json({"event": "hello", "data": {"role": user.role}})
        while True:
            text = await websocket.receive_text()
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "ping":
                await websocket.send_json({"event": "pong", "data": {}})
            elif kind in ("location", "location_off") and conn.role == CITIZEN:
                _handle_location(conn, message)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(conn)
