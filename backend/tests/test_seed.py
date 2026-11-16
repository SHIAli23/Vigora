from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.database import Base
from app.models import Team, User
from app.security import verify_password
from app.seed import seed_demo_data


def test_seed_creates_data_once():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)

    with Session(engine) as db:
        assert seed_demo_data(db) is True
        assert seed_demo_data(db) is False

        users = db.scalars(select(User)).all()
        teams = db.scalars(select(Team)).all()
        assert len(users) == 12
        assert len(teams) == 6

        operator = db.scalar(select(User).where(User.username == "operator"))
        assert verify_password("operator123", operator.password_hash)

        med1 = db.scalar(select(User).where(User.username == "med1"))
        assert med1.team.kind == "medical"
