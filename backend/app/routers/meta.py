"""Reference data for the frontends: incident types, team kinds and statuses."""

from typing import Any

from fastapi import APIRouter

from app.rules import INCIDENT_TYPES, TEAM_KIND_LABELS
from app.services.incidents import STATUS_LABELS

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/meta")
def meta() -> dict[str, Any]:
    """Public, no login needed."""
    return {
        "types": [
            {
                "key": t.key,
                "label": t.label,
                "color": t.color,
                "icon": t.icon,
                "life_threatening": t.life_threatening,
                "violent": t.violent,
            }
            for t in INCIDENT_TYPES.values()
        ],
        "team_kinds": [{"key": key, "label": label} for key, label in TEAM_KIND_LABELS.items()],
        "statuses": [{"key": key, "label": label} for key, label in STATUS_LABELS.items()],
    }
