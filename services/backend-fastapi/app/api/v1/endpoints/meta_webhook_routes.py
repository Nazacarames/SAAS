"""
Meta Webhooks - Facebook/Meta integrations
"""
import hashlib
import hmac
import time
from fastapi import APIRouter, Request, HTTPException, Response
from pydantic import BaseModel

router = APIRouter(prefix="/api/ai", tags=["meta-webhook"])

# Simple in-memory replay cache
replay_cache: dict[str, float] = {}
META_REPLAY_TTL_MS = 10 * 60 * 1000  # 10 min


def check_meta_replay(body: bytes) -> bool:
    """Check if this request is a replay"""
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time() * 1000
    
    # Clean old entries
    global replay_cache
    replay_cache = {k: v for k, v in replay_cache.items() if now - v < META_REPLAY_TTL_MS}
    
    if key in replay_cache:
        return False
    
    replay_cache[key] = now
    return True


class WebhookResponse(BaseModel):
    ok: bool = True


@router.post("/meta-leads/webhook", response_model=WebhookResponse)
async def meta_leads_webhook(req: Request, response: Response):
    """Handle Meta Leads webhook"""
    body = await req.body()
    
    # Replay protection
    if not check_meta_replay(body):
        response.status_code = 202
        return {"ok": True}
    
    # TODO: process lead data
    return {"ok": True}


@router.get("/meta-leads/webhook")
async def meta_leads_verify(req: Request):
    """Verify webhook for Meta"""
    mode = req.query_params.get("hub.mode")
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")
    
    # TODO: verify token
    return challenge
