"""Request and response shapes for the API."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=6, max_length=100)


class RegisterIn(LoginIn):
    full_name: str = Field(min_length=2, max_length=100)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    role: str
    team_id: int | None


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class AssignIn(BaseModel):
    team_id: int


class TeamStatusIn(BaseModel):
    status: Literal["accepted", "on_scene", "resolved"]
