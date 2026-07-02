"""
TOTP two-factor authentication (RFC 6238) — compatible with Google
Authenticator / Authy / 1Password.

The per-user secret is stored encrypted at rest (via crypto.encrypt). A short
-lived "mfa" JWT bridges the two login steps: password check issues it, the TOTP
verification step exchanges it for the real session token.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pyotp
from jose import JWTError, jwt

from app.core.config import settings

ISSUER = "LMTM CRM"
MFA_TOKEN_TTL_SECONDS = 300  # 5 minutes to enter the code


def generate_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, account_email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=account_email, issuer_name=ISSUER)


def verify_code(secret: str, code: str) -> bool:
    if not secret or not code:
        return False
    try:
        # valid_window=1 tolerates ~30s clock skew
        return pyotp.TOTP(secret).verify(str(code).strip().replace(" ", ""), valid_window=1)
    except Exception:
        return False


def create_mfa_token(user_id: int) -> str:
    payload = {
        "id": user_id,
        "scope": "mfa",
        "exp": datetime.now(timezone.utc) + timedelta(seconds=MFA_TOKEN_TTL_SECONDS),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_mfa_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except JWTError:
        return None
    if payload.get("scope") != "mfa":
        return None
    uid = payload.get("id")
    return int(uid) if uid else None
