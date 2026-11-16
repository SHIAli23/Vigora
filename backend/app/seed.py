"""Demo data, created on startup when the database has no users.

Test accounts (username / password):

- Operator: operator / operator123
- Citizens: citizen1 ... citizen5 / citizen123
- Teams:    med1, med2, fire1, fire2, police1, police2 / team123
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import CITIZEN, OPERATOR, TEAM, Team, User
from app.security import hash_password

CITIZEN_NAMES = (
    "Иван Петров",
    "Мария Георгиева",
    "Георги Димитров",
    "Елена Николова",
    "Николай Стоянов",
)

# (username, team name, kind, lat, lng)
TEAMS = (
    ("med1", "Линейка 1 — Пирогов", "medical", 42.6925, 23.3036),
    ("med2", "Линейка 2 — Младост", "medical", 42.6510, 23.3790),
    ("fire1", "Пожарна 1 — Център", "fire", 42.6977, 23.3219),
    ("fire2", "Пожарна 2 — Люлин", "fire", 42.7160, 23.2560),
    ("police1", "Патрул 1 — Център", "police", 42.6960, 23.3260),
    ("police2", "Патрул 2 — Лозенец", "police", 42.6740, 23.3270),
)


def seed_demo_data(db: Session) -> bool:
    """Create the demo users and teams if the users table is empty. Returns True if it did."""
    if db.scalar(select(func.count()).select_from(User)):
        return False

    db.add(
        User(
            username="operator",
            password_hash=hash_password("operator123"),
            full_name="Оператор 112",
            role=OPERATOR,
        )
    )

    citizen_hash = hash_password("citizen123")
    for number, name in enumerate(CITIZEN_NAMES, start=1):
        db.add(
            User(
                username=f"citizen{number}",
                password_hash=citizen_hash,
                full_name=name,
                role=CITIZEN,
            )
        )

    team_hash = hash_password("team123")
    for username, name, kind, lat, lng in TEAMS:
        team = Team(name=name, kind=kind, lat=lat, lng=lng)
        db.add(team)
        db.add(
            User(
                username=username,
                password_hash=team_hash,
                full_name=name,
                role=TEAM,
                team=team,
            )
        )

    db.commit()
    return True
