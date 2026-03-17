from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings


def get_user_by_id(db: Session, user_id: int):
    row = db.execute(
        text(
            'SELECT id, name, email, profile, "companyId" FROM users WHERE id = :id LIMIT 1'
        ),
        {"id": user_id},
    ).mappings().first()
    return row


def get_user_by_email(db: Session, email: str):
    row = db.execute(
        text(
            'SELECT id, name, email, profile, "companyId", "passwordHash" '
            "FROM users WHERE email = :email LIMIT 1"
        ),
        {"email": email},
    ).mappings().first()
    return row


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def _build_token_payload(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "profile": user["profile"],
        "companyId": user["companyId"],
    }


def create_access_token(user: dict) -> str:
    payload = _build_token_payload(user)
    payload["exp"] = datetime.now(timezone.utc) + timedelta(
        minutes=settings.access_token_expire_minutes
    )
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def create_refresh_token(user: dict) -> str:
    payload = _build_token_payload(user)
    payload["exp"] = datetime.now(timezone.utc) + timedelta(
        days=settings.refresh_token_expire_days
    )
    return jwt.encode(payload, settings.jwt_refresh_secret, algorithm="HS256")


def store_refresh_token(db: Session, token: str, user_id: int) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    db.execute(
        text(
            'INSERT INTO refresh_tokens (token, "userId", "expiresAt", revoked, "createdAt") '
            "VALUES (:token, :user_id, :expires_at, false, :now)"
        ),
        {
            "token": token,
            "user_id": user_id,
            "expires_at": expires_at,
            "now": datetime.now(timezone.utc),
        },
    )
    db.commit()


def validate_refresh_token(db: Session, token: str) -> dict | None:
    """Verify JWT signature, check DB record is valid, rotate token."""
    try:
        payload = jwt.decode(token, settings.jwt_refresh_secret, algorithms=["HS256"])
    except JWTError:
        return None

    row = db.execute(
        text(
            "SELECT id FROM refresh_tokens "
            'WHERE token = :token AND revoked = false AND "expiresAt" > :now '
            "LIMIT 1"
        ),
        {"token": token, "now": datetime.now(timezone.utc)},
    ).mappings().first()

    if not row:
        # Possible replay attack — revoke all tokens for user
        db.execute(
            text('UPDATE refresh_tokens SET revoked = true WHERE "userId" = :uid'),
            {"uid": payload.get("id")},
        )
        db.commit()
        return None

    # Revoke used token
    db.execute(
        text("UPDATE refresh_tokens SET revoked = true WHERE id = :id"),
        {"id": row["id"]},
    )
    db.commit()
    return payload


def revoke_user_refresh_tokens(db: Session, user_id: int) -> None:
    db.execute(
        text('UPDATE refresh_tokens SET revoked = true WHERE "userId" = :uid AND revoked = false'),
        {"uid": user_id},
    )
    db.commit()
