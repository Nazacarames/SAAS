import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy import text
from sqlalchemy.orm import Session
import threading
import time

from app.api.deps import get_current_user_payload
from app.core.config import settings
from app.core.db import get_db
from app.schemas.auth import (
    ForgotPasswordRequest,
    GenericOkResponse,
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    MeResponse,
    RefreshRequest,
    RefreshResponse,
    RegisterRequest,
    RegisterResponse,
    ResetPasswordRequest,
)
from app.services.auth_service import (
    create_access_token,
    create_refresh_token,
    create_user_with_company,
    get_user_by_email,
    get_user_by_id,
    hash_password,
    revoke_user_refresh_tokens,
    store_refresh_token,
    user_exists,
    validate_refresh_token,
    verify_password,
)
from app.services.email_service import send_password_reset_email

router = APIRouter(prefix="/auth", tags=["auth"])

_is_prod = settings.environment == "production"


def _cookie_opts() -> dict:
    return {
        "httponly": True,
        "secure": _is_prod,
        "samesite": "none" if _is_prod else "lax",
    }


def _set_auth_cookies(response: Response, access: str, refresh: str) -> None:
    opts = _cookie_opts()
    response.set_cookie(
        key="token",
        value=access,
        max_age=settings.access_token_expire_minutes * 60,
        path="/",
        **opts,
    )
    response.set_cookie(
        key="refreshToken",
        value=refresh,
        max_age=settings.refresh_token_expire_days * 86400,
        path="/api/auth/refresh",
        **opts,
    )


# ── GET /api/auth/me ─────────────────────────────────────────────
@router.get("/me", response_model=MeResponse)
def me(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    user_id = payload.get("id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    row = get_user_by_id(db, int(user_id))
    if not row:
        raise HTTPException(status_code=401, detail="User not found")

    return {"user": row}


# ── POST /api/auth/login ─────────────────────────────────────────
# Login rate limiter: 10 attempts per 15 min per IP
_login_buckets: dict[str, dict] = {}
_login_buckets_lock = threading.Lock()
_LOGIN_WINDOW_MS = 15 * 60 * 1000
_LOGIN_MAX_PER_WINDOW = 10

def _check_login_rate_limit(ip: str) -> bool:
    now = int(time.time() * 1000)
    with _login_buckets_lock:
        bucket = _login_buckets.get(ip)
        if bucket and bucket["resetAt"] > now and bucket["count"] >= _LOGIN_MAX_PER_WINDOW:
            return False
        if not bucket or bucket["resetAt"] <= now:
            _login_buckets[ip] = {"count": 1, "resetAt": now + _LOGIN_WINDOW_MS}
        else:
            bucket["count"] += 1
        return True


@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    _xff = request.headers.get("x-forwarded-for", "")
    _ip = _xff.split(",")[0].strip() if _xff else (request.client.host if request.client else "unknown")
    if not _check_login_rate_limit(_ip):
        raise HTTPException(status_code=429, detail="Demasiados intentos. Intente más tarde.")
    user = get_user_by_email(db, body.email)
    if not user or not verify_password(body.password, user["passwordHash"]):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    access = create_access_token(dict(user))
    refresh = create_refresh_token(dict(user))
    store_refresh_token(db, refresh, user["id"])

    _set_auth_cookies(response, access, refresh)

    return {
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "profile": user["profile"],
            "companyId": user["companyId"],
        },
        "token": access,
    }


# ── POST /api/auth/refresh ───────────────────────────────────────
@router.post("/refresh", response_model=RefreshResponse)
def refresh(
    response: Response,
    body: Optional[RefreshRequest] = None,
    refresh_cookie: str | None = Cookie(default=None, alias="refreshToken"),
    db: Session = Depends(get_db),
):
    raw_token = (body.refreshToken if body and body.refreshToken else None) or refresh_cookie
    if not raw_token:
        raise HTTPException(status_code=401, detail="Refresh token no proporcionado")

    payload = validate_refresh_token(db, raw_token)
    if not payload:
        raise HTTPException(status_code=401, detail="Refresh token inválido")

    user = get_user_by_id(db, payload["id"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    new_access = create_access_token(dict(user))
    new_refresh = create_refresh_token(dict(user))
    store_refresh_token(db, new_refresh, user["id"])

    _set_auth_cookies(response, new_access, new_refresh)

    return {"ok": True, "token": new_access}


# ── POST /api/auth/logout ────────────────────────────────────────
@router.post("/logout", response_model=LogoutResponse)
def logout(
    response: Response,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    revoke_user_refresh_tokens(db, payload["id"])

    opts = _cookie_opts()
    response.delete_cookie(key="token", path="/", **opts)
    response.delete_cookie(key="refreshToken", path="/api/auth/refresh", **opts)

    return {"ok": True}


# ── POST /api/auth/register ──────────────────────────────────────
# Rate limiter: 5 attempts per 15 minutes per IP (thread-safe)
_register_buckets: dict[str, dict] = {}
_register_buckets_lock = threading.Lock()
_REGISTER_WINDOW_MS = 15 * 60 * 1000
_REGISTER_MAX_PER_WINDOW = 5


def _check_register_rate_limit(ip: str) -> bool:
    """Returns True if request should be allowed, False if rate limited (thread-safe)."""
    now = int(time.time() * 1000)
    with _register_buckets_lock:
        bucket = _register_buckets.get(ip)
        if bucket and bucket["resetAt"] > now and bucket["count"] >= _REGISTER_MAX_PER_WINDOW:
            return False
        if not bucket or bucket["resetAt"] <= now:
            _register_buckets[ip] = {"count": 1, "resetAt": now + _REGISTER_WINDOW_MS}
        else:
            bucket["count"] += 1
        return True


@router.post("/register", response_model=RegisterResponse, status_code=201)
def register(
    body: RegisterRequest,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    # Rate limiting — use real client IP (X-Forwarded-For from nginx, fallback to direct)
    _xff = request.headers.get("x-forwarded-for", "")
    ip = _xff.split(",")[0].strip() if _xff else (request.client.host if request.client else "unknown")

    if not _check_register_rate_limit(ip):
        raise HTTPException(
            status_code=429,
            detail="Demasiados intentos de registro. Intente más tarde.",
        )

    # Validation
    email = body.email.strip().lower()
    name = body.name.strip()
    password = body.password
    company_name = body.companyName.strip()

    if not company_name or not name or not email or not password:
        raise HTTPException(status_code=400, detail="Faltan datos requeridos")

    import re
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        raise HTTPException(status_code=400, detail="Email inválido")

    if len(password) < 8:
        raise HTTPException(
            status_code=400,
            detail="La contraseña debe tener al menos 8 caracteres",
        )

    # Check existing user
    if user_exists(db, email):
        raise HTTPException(status_code=409, detail="El email ya está registrado")

    # Create user and company
    user = create_user_with_company(db, name, email, password, company_name)

    # Generate tokens
    access = create_access_token(user)
    refresh = create_refresh_token(user)
    store_refresh_token(db, refresh, user["id"])

    _set_auth_cookies(response, access, refresh)

    return {
        "ok": True,
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "profile": user["profile"],
            "companyId": user["companyId"],
        },
        "token": access,
    }


# ── POST /api/auth/forgot-password ───────────────────────────────
_forgot_buckets: dict[str, dict] = {}
_forgot_buckets_lock = threading.Lock()
_FORGOT_WINDOW_MS = 15 * 60 * 1000
_FORGOT_MAX_PER_WINDOW = 5


def _check_forgot_rate_limit(ip: str) -> bool:
    now = int(time.time() * 1000)
    with _forgot_buckets_lock:
        bucket = _forgot_buckets.get(ip)
        if bucket and bucket["resetAt"] > now and bucket["count"] >= _FORGOT_MAX_PER_WINDOW:
            return False
        if not bucket or bucket["resetAt"] <= now:
            _forgot_buckets[ip] = {"count": 1, "resetAt": now + _FORGOT_WINDOW_MS}
        else:
            bucket["count"] += 1
        return True


@router.post("/forgot-password", response_model=GenericOkResponse)
def forgot_password(
    body: ForgotPasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    _xff = request.headers.get("x-forwarded-for", "")
    ip = _xff.split(",")[0].strip() if _xff else (request.client.host if request.client else "unknown")
    if not _check_forgot_rate_limit(ip):
        raise HTTPException(status_code=429, detail="Demasiados intentos. Intente más tarde.")

    user = get_user_by_email(db, body.email.strip().lower())
    if not user:
        return {"ok": True}

    token = secrets.token_urlsafe(48)
    expires = datetime.now(timezone.utc) + timedelta(hours=1)
    db.execute(
        text(
            "INSERT INTO password_reset_tokens (user_id, token, expires_at) "
            "VALUES (:uid, :token, :exp)"
        ),
        {"uid": user["id"], "token": token, "exp": expires},
    )
    db.commit()

    send_password_reset_email(user["email"], user["name"], token)
    return {"ok": True}


# ── POST /api/auth/reset-password ────────────────────────────────
@router.post("/reset-password", response_model=GenericOkResponse)
def reset_password(
    body: ResetPasswordRequest,
    db: Session = Depends(get_db),
):
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 8 caracteres")

    row = db.execute(
        text(
            "SELECT id, user_id FROM password_reset_tokens "
            "WHERE token = :token AND used_at IS NULL AND expires_at > :now "
            "LIMIT 1 FOR UPDATE"
        ),
        {"token": body.token, "now": datetime.now(timezone.utc)},
    ).mappings().first()

    if not row:
        raise HTTPException(status_code=400, detail="El enlace expiró o ya fue usado. Solicitá uno nuevo.")

    new_hash = hash_password(body.password)
    db.execute(
        text('UPDATE users SET "passwordHash" = :h, "updatedAt" = :now WHERE id = :uid'),
        {"h": new_hash, "now": datetime.now(timezone.utc), "uid": row["user_id"]},
    )
    db.execute(
        text("UPDATE password_reset_tokens SET used_at = :now WHERE id = :id"),
        {"now": datetime.now(timezone.utc), "id": row["id"]},
    )
    revoke_user_refresh_tokens(db, row["user_id"])
    db.commit()

    return {"ok": True}
