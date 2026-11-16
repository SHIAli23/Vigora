"""Password hashing and login tokens."""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from app.config import settings

PBKDF2_ITERATIONS = 200_000
JWT_ALGORITHM = "HS256"


def _pbkdf2(password: str, salt: str, iterations: int) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations)
    return digest.hex()


def hash_password(password: str) -> str:
    """Hash a password with a random salt. Format: pbkdf2$<iterations>$<salt>$<hex digest>."""
    salt = secrets.token_hex(16)
    digest = _pbkdf2(password, salt, PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    """Check a password against a stored hash. Returns False if the stored value is malformed."""
    try:
        scheme, iterations, salt, digest = stored.split("$")
        if scheme != "pbkdf2":
            return False
        expected = _pbkdf2(password, salt, int(iterations))
    except (ValueError, AttributeError):
        return False
    # Constant-time comparison, so the response time does not leak how much matched.
    return hmac.compare_digest(expected, digest)


def create_token(user_id: int, role: str) -> str:
    """Create a signed login token that expires after settings.token_expire_hours."""
    payload = {
        "sub": str(user_id),
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.token_expire_hours),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict[str, Any] | None:
    """Return the token's payload, or None if the token is invalid or expired."""
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
