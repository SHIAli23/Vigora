"""Real-time push to logged-in clients over WebSocket."""

import asyncio
import time
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket

from app.models import OPERATOR


@dataclass(eq=False)
class Connection:
    """One open WebSocket and the user behind it. Compared by identity, so it can be removed safely."""

    websocket: WebSocket
    user_id: int
    role: str
    team_id: int | None


class ConnectionManager:
    """Keeps the open connections and sends events to groups of them."""

    def __init__(self) -> None:
        self.connections: list[Connection] = []

    async def connect(self, conn: Connection) -> None:
        await conn.websocket.accept()
        self.connections.append(conn)

    def disconnect(self, conn: Connection) -> None:
        if conn in self.connections:
            self.connections.remove(conn)

    async def _send(self, targets: Iterable[Connection], event: str, data: Any) -> None:
        """Send one event to all targets at once. Connections that fail are dropped."""
        targets = list(targets)
        if not targets:
            return
        message = {"event": event, "data": data, "sent_at": time.time() * 1000}
        results = await asyncio.gather(
            *(conn.websocket.send_json(message) for conn in targets),
            return_exceptions=True,
        )
        for conn, result in zip(targets, results):
            if isinstance(result, Exception):
                self.disconnect(conn)

    async def to_operators(self, event: str, data: Any) -> None:
        await self._send([c for c in self.connections if c.role == OPERATOR], event, data)

    async def to_user(self, user_id: int, event: str, data: Any) -> None:
        await self._send([c for c in self.connections if c.user_id == user_id], event, data)

    async def to_users(self, user_ids: set[int], event: str, data: Any) -> None:
        await self._send([c for c in self.connections if c.user_id in user_ids], event, data)

    async def to_team(self, team_id: int, event: str, data: Any) -> None:
        await self._send([c for c in self.connections if c.team_id == team_id], event, data)

    def online_count(self) -> dict[str, int]:
        """Number of open connections per role."""
        return dict(Counter(c.role for c in self.connections))


manager = ConnectionManager()
