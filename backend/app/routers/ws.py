"""WebSocket endpoint for real-time events. The login token is passed as a query parameter."""

import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from app.database import SessionLocal
from app.models import User
from app.realtime import Connection, manager
from app.security import decode_token

router = APIRouter(tags=["realtime"])


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
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"event": "pong", "data": {}})
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(conn)
