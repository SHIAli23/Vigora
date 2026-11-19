from datetime import timedelta

from app.database import utcnow
from app.models import CITIZEN, STATUS_NEW, User
from app.services.incidents import incident_detail, incident_summary, submit_report

# Plovdiv, away from the Sofia points other tests may save.
HERE = (42.1354, 24.7453)
CLOSE_BY = (42.1360, 24.7453)  # about 70 m north


def make_citizen(db, username):
    user = User(username=username, password_hash="x", full_name=username, role=CITIZEN, trust=50)
    db.add(user)
    db.flush()
    return user


def report(db, user, point=HERE, now=None, **fields):
    values = dict(description="", people_affected=0, photo=None)
    values.update(fields)
    return submit_report(db, user, "medical", *point, now=now or utcnow(), **values)


def test_new_report_creates_incident(db):
    user = make_citizen(db, "svc_citizen_a")

    rep, incident, is_new = report(db, user, description="  Човек падна  ", people_affected=1)

    assert is_new
    assert incident.status == STATUS_NEW
    assert incident.reports_count == 1
    assert rep.incident is incident
    assert rep.description == "Човек падна"
    assert [e.text for e in incident.events] == ["Нов сигнал: Медицински случай"]

    summary = incident_summary(incident, utcnow())
    assert summary["status_label"] == "Приет от 112"
    assert summary["confirmed"] is False
    assert summary["urgency"] >= 60
    assert summary["created_at"].endswith("Z")


def test_close_report_from_another_citizen_merges(db):
    first = make_citizen(db, "svc_citizen_b")
    second = make_citizen(db, "svc_citizen_c")
    now = utcnow()

    _, incident, _ = report(db, first, now=now, people_affected=1)
    _, merged, is_new = report(
        db, second, point=CLOSE_BY, now=now + timedelta(minutes=2),
        people_affected=3, photo="photo.jpg",
    )

    assert not is_new
    assert merged is incident
    assert incident.reports_count == 2
    assert incident.people_affected == 3
    assert incident.has_photo
    assert incident.first_confirmed_at == now + timedelta(minutes=2)
    assert incident.events[-1].text == "Обединен дублиран сигнал (общо 2 подателя)"

    detail = incident_detail(incident, now)
    assert detail["confirmed"] is True
    assert len(detail["reports"]) == 2
    assert detail["reports"][1]["photo"] == "photo.jpg"


def test_same_citizen_twice_does_not_count_again(db):
    user = make_citizen(db, "svc_citizen_d")

    _, incident, _ = report(db, user)
    _, again, is_new = report(db, user, point=CLOSE_BY)

    assert not is_new
    assert again is incident
    assert incident.reports_count == 1
    assert incident.first_confirmed_at is None
    assert len(incident.reports) == 2
    assert incident.events[-1].text == "Повторен сигнал от същия човек (не се брои отново)"
