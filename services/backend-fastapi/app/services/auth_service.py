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


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def create_user_with_company(
    db: Session,
    name: str,
    email: str,
    password: str,
    company_name: str,
) -> dict:
    """
    Create a new company and user in a transaction.
    Assigns trial_30 plan to the new company.
    Returns the created user dict.
    """
    from datetime import datetime, timezone, timedelta

    # Create company
    now = datetime.now(timezone.utc)
    company_result = db.execute(
        text(
            'INSERT INTO companies (name, email, status, "createdAt", "updatedAt") '
            'VALUES (:name, :email, true, :now, :now) RETURNING id'
        ),
        {"name": company_name, "email": email, "now": now},
    )
    company_row = company_result.mappings().first()
    if not company_row:
        raise Exception("Failed to create company")
    company_id = company_row["id"]

    # Create user with hashed password
    password_hash = hash_password(password)
    user_result = db.execute(
        text(
            'INSERT INTO users (name, email, "passwordHash", profile, "companyId", "createdAt", "updatedAt") '
            'VALUES (:name, :email, :password_hash, :profile, :company_id, :now, :now) RETURNING id, name, email, profile, "companyId"'
        ),
        {
            "name": name,
            "email": email,
            "password_hash": password_hash,
            "profile": "admin",
            "company_id": company_id,
            "now": now,
        },
    )
    user_row = user_result.mappings().first()
    if not user_row:
        raise Exception("Failed to create user")

    # Assign trial_30 plan if it exists
    trial_result = db.execute(
        text("SELECT id FROM plans WHERE code = 'trial_30' LIMIT 1")
    )
    trial_row = trial_result.mappings().first()

    if trial_row:
        trial_ends = now + timedelta(days=30)
        db.execute(
            text(
                'INSERT INTO subscriptions ("companyId", "planId", status, "trialStartsAt", "trialEndsAt", '
                '"currentPeriodStart", "currentPeriodEnd", metadata, "createdAt", "updatedAt") '
                'VALUES (:company_id, :plan_id, :status, :trial_starts, :trial_ends, :period_start, :period_end, :metadata, :now, :now)'
            ),
            {
                "company_id": company_id,
                "plan_id": trial_row["id"],
                "status": "trialing",
                "trial_starts": now,
                "trial_ends": trial_ends,
                "period_start": now,
                "period_end": trial_ends,
                "metadata": "{}",
                "now": now,
            },
        )

    db.commit()
    return dict(user_row)


def user_exists(db: Session, email: str) -> bool:
    """Check if a user with this email already exists."""
    row = db.execute(
        text('SELECT id FROM users WHERE email = :email LIMIT 1'),
        {"email": email},
    ).mappings().first()
    return row is not None
