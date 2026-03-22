from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session
import threading
import time

from app.api.deps import get_current_user_payload
from app.core.config import settings
from app.core.db import get_db
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    MeResponse,
    RefreshRequest,
    RefreshResponse,
    RegisterRequest,
    RegisterResponse,
)
from app.services.auth_service import (
    create_access_token,
    create_refresh_token,
    create_user_with_company,
    get_user_by_email,
    get_user_by_id,
    revoke_user_refresh_tokens,
    store_refresh_token,
    user_exists,
    validate_refresh_token,
    verify_password,
)

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
@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
):
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
    body: RefreshRequest | None = None,
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
    db: Session = Depends(get_db),
    request: Request | None = None,
):
    # Rate limiting
    ip = "unknown"
    if request:
        ip = request.client.host if request.client else "unknown"

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
