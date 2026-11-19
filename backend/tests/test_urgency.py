from datetime import datetime, timedelta

import pytest

from app.models import CITIZEN, STATUS_ASSIGNED, STATUS_NEW, Incident, Report, User
from app.services.reputation import average_trust, reporters
from app.services.urgency import calculate, level_for

NOW = datetime(2026, 1, 1, 12, 0)
# The "other" type has base score 10, which keeps the numbers small.
BASE = 10


def make_incident(type_="other", minutes_ago=0, **fields):
    """An incident in memory, with every counter set (column defaults apply only on save)."""
    values = dict(
        type=type_,
        status=STATUS_NEW,
        lat=42.6955,
        lng=23.3290,
        people_affected=0,
        has_photo=False,
        reports_count=1,
        witness_yes=0,
        witness_no=0,
        witness_unsure=0,
        created_at=NOW - timedelta(minutes=minutes_ago),
    )
    values.update(fields)
    return Incident(**values)


def score(incident, trust=50.0):
    return calculate(incident, trust, NOW)


def labels(urgency):
    return [part["label"] for part in urgency.breakdown]


def points(urgency, label_start):
    return next(p["points"] for p in urgency.breakdown if p["label"].startswith(label_start))


def test_base_score_only():
    urgency = score(make_incident("medical"))

    assert urgency.score == 60
    assert urgency.breakdown == [{"label": "Тип: Медицински случай", "points": 60}]


def test_people_affected():
    urgency = score(make_incident(people_affected=2))

    assert "Засегнати хора: 2" in labels(urgency)
    assert urgency.score == BASE + 20


def test_people_affected_cap():
    urgency = score(make_incident(people_affected=12))

    assert points(urgency, "Засегнати хора") == 50


def test_confirmations_from_reports_and_witnesses():
    urgency = score(make_incident(reports_count=3, witness_yes=1))

    assert "Потвърждения: 3" in labels(urgency)
    assert urgency.score == BASE + 24


def test_confirmations_cap():
    urgency = score(make_incident(reports_count=10, witness_yes=5))

    assert points(urgency, "Потвърждения") == 48


def test_photo_bonus():
    urgency = score(make_incident(has_photo=True))

    assert "Има снимка" in labels(urgency)
    assert urgency.score == BASE + 5


def test_waiting_time():
    urgency = score(make_incident(minutes_ago=10))

    assert "Чака 10 мин" in labels(urgency)
    assert urgency.score == BASE + 5


def test_waiting_time_cap():
    urgency = score(make_incident(minutes_ago=120))

    assert points(urgency, "Чака") == 15


def test_waiting_under_one_point_is_skipped():
    urgency = score(make_incident(minutes_ago=1))

    assert not any(label.startswith("Чака") for label in labels(urgency))


def test_waiting_counts_only_while_new():
    urgency = score(make_incident(minutes_ago=30, status=STATUS_ASSIGNED))

    assert not any(label.startswith("Чака") for label in labels(urgency))
    assert urgency.score == BASE


def test_witness_denials():
    urgency = score(make_incident("medical", witness_no=2))

    assert points(urgency, "Отхвърляния от свидетели: 2") == -20
    assert urgency.score == 40


def test_trust_up():
    urgency = score(make_incident(), trust=80)

    assert points(urgency, "Репутация на подателите") == 6
    assert urgency.score == BASE + 6


def test_trust_down():
    urgency = score(make_incident(), trust=20)

    assert points(urgency, "Репутация на подателите") == -6
    assert urgency.score == BASE - 6


def test_small_trust_difference_is_skipped():
    urgency = score(make_incident(), trust=54)

    assert "Репутация на подателите" not in labels(urgency)


def test_score_never_below_zero():
    urgency = score(make_incident(witness_no=5), trust=0)

    assert urgency.score == 0
    assert urgency.level == "low"


@pytest.mark.parametrize(
    ("value", "level"),
    [(100, "critical"), (90, "critical"), (89, "high"), (65, "high"),
     (64, "medium"), (40, "medium"), (39, "low"), (0, "low")],
)
def test_levels(value, level):
    assert level_for(value) == level


def test_reporters_are_unique_and_trust_is_averaged():
    alice = User(username="a", password_hash="x", full_name="A", role=CITIZEN, trust=80)
    bob = User(username="b", password_hash="x", full_name="B", role=CITIZEN, trust=40)
    incident = make_incident()
    for user in (alice, alice, bob):
        incident.reports.append(Report(user=user, type="other", lat=0, lng=0))

    assert reporters(incident) == [alice, bob]
    assert average_trust(incident) == 60.0


def test_average_trust_without_reports():
    assert average_trust(make_incident()) == 50.0
