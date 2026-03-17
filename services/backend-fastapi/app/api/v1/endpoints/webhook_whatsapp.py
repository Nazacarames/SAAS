from fastapi import APIRouter, Request, HTTPException, Response
from pydantic import BaseModel
import hashlib
import hmac
import time

router = APIRouter(prefix="/whatsapp-cloud", tags=["whatsapp-webhook"])

# In-memory replay cache (simple version)
replay_cache: dict[str, float] = {}
SIGNATURE_MAX_AGE_SECONDS = 300


def get_app_secret() -> str:
    # TODO: load from settings/DB
    return ""


def verify_signature(req: Request, body: bytes, signature: str | None) -> bool:
    app_secret = get_app_secret()
    if not app_secret or not signature:
        return True  # Skip in dev

    expected = hmac.new(
        app_secret.encode(),
        body,
        "sha256"
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def check_replay(body: bytes) -> bool:
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time()

    # Clean old entries
    global replay_cache
    replay_cache = {k: v for k, v in replay_cache.items() if now - v < 3600}

    if key in replay_cache:
        return False

    replay_cache[key] = now
    return True


class WebhookResponse(BaseModel):
    ok: bool = True


@router.post("/webhook", response_model=WebhookResponse)
async def whatsapp_webhook(req: Request, response: Response):
    body = await req.body()

    # Signature verification (optional in dev)
    signature = req.headers.get("x-hub-signature-256", "")
    if not verify_signature(req, body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Replay protection
    if not check_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay_blocked"}

    # Process payload (placeholder - calls Node service logic)
    # TODO: integrate with actual ProcessCloudWebhookPayload from Node

    return {"ok": True}
