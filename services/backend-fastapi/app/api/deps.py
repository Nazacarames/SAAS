from fastapi import Cookie, Header, HTTPException, Depends
from jose import JWTError, jwt

from app.core.config import settings


def get_current_user_payload(
    authorization: str | None = Header(default=None),
    token_cookie: str | None = Cookie(default=None, alias="token"),
):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1].strip()
    elif token_cookie:
        token = token_cookie

    if not token:
        raise HTTPException(status_code=401, detail="Token no proporcionado")

    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except JWTError:
        raise HTTPException(status_code=401, detail="Token inválido")


def require_admin(payload: dict = Depends(get_current_user_payload)):
    profile = str(payload.get("profile", "")).lower()
    if profile not in {"admin", "super"}:
        raise HTTPException(status_code=403, detail="Admin only")
    return payload
