from datetime import timedelta

from app.database import utcnow
from app.models import STATUS_ASSIGNED, STATUS_RESOLVED, Incident
from app.services.dedup import find_matching_incident
from tests.conftest import FAR, NEAR, POINT

# The "medical" type merges reports within 150 m and 20 minutes.


def add_incident(db, type_="medical", point=POINT, status=None, minutes_ago=0):
    now = utcnow()
    incident = Incident(
        type=type_,
        lat=point[0],
        lng=point[1],
        last_report_at=now - timedelta(minutes=minutes_ago),
    )
    if status:
        incident.status = status
    db.add(incident)
    # Flush, not commit: the session is rolled back when the test ends.
    db.flush()
    return incident


def test_close_incident_is_found(db):
    incident = add_incident(db, point=NEAR)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is incident


def test_far_incident_is_not_found(db):
    add_incident(db, point=FAR)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is None


def test_other_type_is_not_found(db):
    add_incident(db, type_="fire", point=NEAR)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is None


def test_closed_incident_is_not_found(db):
    add_incident(db, point=NEAR, status=STATUS_RESOLVED)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is None


def test_incident_older_than_window_is_not_found(db):
    add_incident(db, point=NEAR, minutes_ago=25)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is None


def test_open_assigned_incident_is_found(db):
    incident = add_incident(db, point=NEAR, status=STATUS_ASSIGNED)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is incident


def test_nearest_incident_wins(db):
    add_incident(db, point=NEAR)
    nearest = add_incident(db, point=POINT)

    assert find_matching_incident(db, "medical", *POINT, utcnow()) is nearest
