from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, utcnow

# User roles
CITIZEN = "citizen"
OPERATOR = "operator"
TEAM = "team"
ROLES = (CITIZEN, OPERATOR, TEAM)

# Incident statuses
STATUS_NEW = "new"
STATUS_ASSIGNED = "assigned"
STATUS_ACCEPTED = "accepted"
STATUS_ON_SCENE = "on_scene"
STATUS_RESOLVED = "resolved"
STATUS_FALSE = "false_report"
OPEN_STATUSES = (STATUS_NEW, STATUS_ASSIGNED, STATUS_ACCEPTED, STATUS_ON_SCENE)

# Witness answers
ANSWER_YES = "yes"
ANSWER_NO = "no"
ANSWER_UNSURE = "unsure"
ANSWERS = (ANSWER_YES, ANSWER_NO, ANSWER_UNSURE)

# Team statuses
TEAM_AVAILABLE = "available"
TEAM_BUSY = "busy"


class User(Base):
    """A person who logs in: a citizen, a 112 operator or a member of a response team."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20), index=True)
    # Hidden reputation from 0 to 100. Never shown to the citizen.
    trust: Mapped[int] = mapped_column(Integer, default=50)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    team: Mapped["Team | None"] = relationship(back_populates="members")


class Team(Base):
    """A response team (ambulance, fire crew or police patrol) with its current position."""

    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20), index=True)  # medical, fire or police
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default=TEAM_AVAILABLE)
    # Plain number, not a foreign key, to avoid a circular reference with incidents.
    current_incident_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    members: Mapped[list["User"]] = relationship(back_populates="team")


class Incident(Base):
    """One real-world event. Several citizen reports about the same event are grouped here."""

    __tablename__ = "incidents"

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20), default=STATUS_NEW, index=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    people_affected: Mapped[int] = mapped_column(Integer, default=0)
    has_photo: Mapped[bool] = mapped_column(Boolean, default=False)
    reports_count: Mapped[int] = mapped_column(Integer, default=1)
    witness_yes: Mapped[int] = mapped_column(Integer, default=0)
    witness_no: Mapped[int] = mapped_column(Integer, default=0)
    witness_unsure: Mapped[int] = mapped_column(Integer, default=0)
    assigned_team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_report_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    first_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    reports: Mapped[list["Report"]] = relationship(
        back_populates="incident", order_by="Report.id"
    )
    witness_requests: Mapped[list["WitnessRequest"]] = relationship(back_populates="incident")
    events: Mapped[list["IncidentEvent"]] = relationship(
        back_populates="incident", order_by="IncidentEvent.id"
    )
    assigned_team: Mapped["Team | None"] = relationship()


class Report(Base):
    """A single signal sent by one citizen. It always belongs to an incident."""

    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey("incidents.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String(30))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    description: Mapped[str] = mapped_column(Text, default="")
    people_affected: Mapped[int] = mapped_column(Integer, default=0)
    photo: Mapped[str | None] = mapped_column(String(255), nullable=True)  # file name in uploads
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    incident: Mapped["Incident"] = relationship(back_populates="reports")
    user: Mapped["User"] = relationship()
    photo_check: Mapped["PhotoCheck | None"] = relationship(
        primaryjoin="foreign(Report.photo) == PhotoCheck.name", viewonly=True
    )


class WitnessRequest(Base):
    """A question sent to a citizen near an incident: "Do you see this happening?"."""

    __tablename__ = "witness_requests"
    __table_args__ = (UniqueConstraint("incident_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey("incidents.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    distance_m: Mapped[float] = mapped_column(Float)
    asked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    answer: Mapped[str | None] = mapped_column(String(10), nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    photo: Mapped[str | None] = mapped_column(String(255), nullable=True)

    incident: Mapped["Incident"] = relationship(back_populates="witness_requests")
    user: Mapped["User"] = relationship()
    photo_check: Mapped["PhotoCheck | None"] = relationship(
        primaryjoin="foreign(WitnessRequest.photo) == PhotoCheck.name", viewonly=True
    )


class PhotoCheck(Base):
    """What the photo check found for one saved photo (see services/photo_check).

    The photo itself is stored without metadata; only these signals and the hash are kept.
    """

    __tablename__ = "photo_checks"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)  # file name in uploads
    level: Mapped[str] = mapped_column(String(10))  # ok, check or warning
    reasons: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of texts
    phash: Mapped[str] = mapped_column(String(16), default="")  # difference hash, 16 hex digits
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class IncidentEvent(Base):
    """One line in an incident's history, shown to the operator."""

    __tablename__ = "incident_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey("incidents.id"), index=True)
    text: Mapped[str] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    incident: Mapped["Incident"] = relationship(back_populates="events")


class PushSubscription(Base):
    """A browser where a citizen allowed notifications for witness questions.

    Only the push service address and the browser's encryption keys are stored, never a location.
    """

    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # One row per browser: the push service gives each browser its own address.
    endpoint: Mapped[str] = mapped_column(String(1000), unique=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
