"""Rules for each incident type.

Adding a new incident type means adding one entry to INCIDENT_TYPES, not new code.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class IncidentType:
    """Settings for one kind of incident."""

    key: str
    label: str
    # Starting priority score of a new incident of this type.
    base_score: int
    # A new report joins an existing incident of the same type
    # if it is this close in space and time.
    merge_radius_m: int
    merge_window_min: int
    # Citizens within this distance are asked to confirm the incident.
    witness_radius_m: int
    # Which kinds of teams can respond.
    team_kinds: tuple[str, ...]
    witness_question: str
    # Witnesses are warned to stay away.
    violent: bool
    life_threatening: bool
    color: str
    icon: str


INCIDENT_TYPES: dict[str, IncidentType] = {
    t.key: t
    for t in (
        IncidentType(
            key="medical",
            label="Медицински случай",
            base_score=60,
            merge_radius_m=150,
            merge_window_min=20,
            witness_radius_m=300,
            team_kinds=("medical",),
            witness_question="Виждате ли човек, който се нуждае от медицинска помощ?",
            violent=False,
            life_threatening=True,
            color="#2563eb",
            icon="🚑",
        ),
        IncidentType(
            key="fire",
            label="Пожар",
            base_score=55,
            merge_radius_m=300,
            merge_window_min=30,
            witness_radius_m=400,
            team_kinds=("fire",),
            witness_question="Виждате ли дим или огън?",
            violent=False,
            life_threatening=True,
            color="#dc2626",
            icon="🔥",
        ),
        IncidentType(
            key="violence",
            label="Грабеж / насилие",
            base_score=50,
            merge_radius_m=100,
            merge_window_min=10,
            witness_radius_m=200,
            team_kinds=("police",),
            witness_question="Виждате ли сбиване, грабеж или нападение?",
            violent=True,
            life_threatening=True,
            color="#7c3aed",
            icon="🚨",
        ),
        IncidentType(
            key="accident",
            label="Катастрофа",
            base_score=45,
            merge_radius_m=200,
            merge_window_min=20,
            witness_radius_m=300,
            team_kinds=("medical", "police"),
            witness_question="Виждате ли катастрофа на пътя?",
            violent=False,
            life_threatening=True,
            color="#ea580c",
            icon="🚗",
        ),
        IncidentType(
            key="suspicious",
            label="Подозрителна активност",
            base_score=20,
            merge_radius_m=100,
            merge_window_min=15,
            witness_radius_m=200,
            team_kinds=("police",),
            witness_question="Забелязвате ли подозрителна активност наблизо?",
            violent=True,
            life_threatening=False,
            color="#ca8a04",
            icon="👀",
        ),
        IncidentType(
            key="other",
            label="Друго",
            base_score=10,
            merge_radius_m=100,
            merge_window_min=15,
            witness_radius_m=200,
            team_kinds=("police", "medical", "fire"),
            witness_question="Виждате ли проблем на това място?",
            violent=False,
            life_threatening=False,
            color="#6b7280",
            icon="❓",
        ),
    )
}

TEAM_KIND_LABELS = {
    "medical": "Медицински екип",
    "fire": "Пожарен екип",
    "police": "Полиция",
}

# How long a witness has to answer a question.
WITNESS_ANSWER_WINDOW_MIN = 10
# A citizen's last known location older than this is not used to find witnesses.
LOCATION_MAX_AGE_MIN = 10
MAX_WITNESSES_PER_INCIDENT = 10


def get_type(key: str) -> IncidentType:
    """Return the rules for an incident type. Raises KeyError for an unknown key."""
    return INCIDENT_TYPES[key]


def witness_question_text(incident_type: IncidentType) -> str:
    """Build the question shown to a nearby citizen, with a safety warning for violent types."""
    warning = "Не се приближавайте! " if incident_type.violent else ""
    return (
        f"{warning}Наблизо е подаден сигнал: {incident_type.label.lower()}. "
        f"От безопасно място: {incident_type.witness_question}"
    )
