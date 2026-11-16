"""Login, registration and the current user."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import CITIZEN, User
from app.schemas import LoginIn, RegisterIn, TokenOut, UserOut
from app.security import create_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def token_response(user: User) -> TokenOut:
    return TokenOut(
        access_token=create_token(user.id, user.role),
        user=UserOut.model_validate(user),
    )


@router.post("/login")
def login(data: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
    user = db.scalar(select(User).where(User.username == data.username))
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Грешно потребителско име или парола",
        )
    return token_response(user)


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(data: RegisterIn, db: Session = Depends(get_db)) -> TokenOut:
    """Create a citizen account. Operators and teams are never self-registered."""
    if db.scalar(select(User).where(User.username == data.username)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Потребителското име е заето",
        )
    user = User(
        username=data.username,
        password_hash=hash_password(data.password),
        full_name=data.full_name,
        role=CITIZEN,
    )
    db.add(user)
    db.commit()
    return token_response(user)


@router.get("/me")
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)
