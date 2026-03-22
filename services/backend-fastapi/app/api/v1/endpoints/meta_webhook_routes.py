"""
Meta Webhooks - Facebook/Meta integrations
Migrated from Node.js metaWebhookRoutes
"""
import hashlib
import hmac
import time
import os
import threading
from typing import Optional
from fastapi import APIRouter, Request, HTTPException, Response, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db
from app.core.config import settings

router = APIRouter(prefix="", tags=["meta-webhook"])

# Thread-safe in-memory replay cache with TTL
_replay_cache: dict[str, float] = {}
_replay_cache_lock = threading.Lock()
META_REPLAY_TTL_MS = 10 * 60 * 1000  # 10 min
META_VERIFY_TOKEN = os.getenv("META_WEBHOOK_VERIFY_TOKEN", "")  # Empty = accept any


def check_meta_replay(body: bytes) -> bool:
    """Check if this request is a replay (thread-safe)"""
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time() * 1000

    with _replay_cache_lock:
        # Remove expired entries (TTL-based eviction)
        for k in list(_replay_cache.keys()):
            if now - _replay_cache[k] >= META_REPLAY_TTL_MS:
                del _replay_cache[k]

        if key in _replay_cache:
            return False

        _replay_cache[key] = now
        return True


def verify_meta_signature(body: bytes, signature: str) -> bool:
    """Verify Meta webhook signature"""
    if not signature:
        if settings.environment == "production":
            return False
        return True  # Skip in dev

    app_secret = os.getenv("META_APP_SECRET", "")
    if not app_secret:
        if settings.environment == "production":
            print("WARNING: META_APP_SECRET not configured - rejecting webhook in production")
            return False
        return True
    
    expected = hmac.new(
        app_secret.encode(),
        body,
        "sha256"
    ).hexdigest()
    
    return hmac.compare_digest(f"sha256={expected}", signature)


class WebhookResponse(BaseModel):
    ok: bool = True


# --- Lead Gen Webhooks ---
@router.get("/leadgen")
async def leadgen_verify(req: Request):
    """Verify webhook for Meta Lead Gen"""
    mode = req.query_params.get("hub.mode")
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")

    if not META_VERIFY_TOKEN:
        if settings.environment == "production":
            raise HTTPException(status_code=500, detail="META_WEBHOOK_VERIFY_TOKEN not configured")
        # In dev, skip verification (accept any token)
        return challenge

    if token != META_VERIFY_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid verify token")

    return challenge


@router.post("/leadgen")
async def leadgen_webhook(req: Request, response: Response, db: Session = Depends(get_db)):
    """Handle Meta Lead Gen webhook"""
    body = await req.body()
    
    # Signature verification
    signature = req.headers.get("x-hub-signature-256", "")
    if not verify_meta_signature(body, signature):
        raise HTTPException(status_code=401, detail="Invalid signature")
    
    # Replay protection
    if not check_meta_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay"}
    
    # Parse payload
    try:
        import json
        payload = json.loads(body)
    except:
        return {"ok": True, "ignored": True, "reason": "invalid_json"}
    
    # Extract lead data
    try:
        entry_id = payload.get("entry", [{}])[0].get("id", "")
        changes = payload.get("entry", [{}])[0].get("changes", [{}])
        
        for change in changes:
            field = change.get("field", "")
            if field != "leadgen":
                continue
            
            value = change.get("value", {})
            lead_id = value.get("leadgen_id", "")
            form_id = value.get("form_id", "")
            campaign_id = value.get("campaign_id", "")
            
            # Get lead details from Meta API (requires access token)
            # For now, just log the lead
            print(f"Meta lead received: lead_id={lead_id}, form_id={form_id}")
            
            # TODO: fetch lead details from Meta API and create contact
    
    except Exception as e:
        print(f"Error processing leadgen webhook: {e}")
    
    return {"ok": True}


@router.post("/meta-leads/webhook")
async def meta_leads_webhook(req: Request, response: Response):
    """Handle Meta Leads webhook (legacy endpoint)"""
    body = await req.body()
    
    # Signature verification
    signature = req.headers.get("x-hub-signature-256", "")
    if not verify_meta_signature(body, signature):
        raise HTTPException(status_code=401, detail="Invalid signature")
    
    # Replay protection
    if not check_meta_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay"}
    
    return {"ok": True}


@router.get("/meta-leads/webhook")
async def meta_leads_verify(req: Request):
    """Verify webhook for Meta"""
    mode = req.query_params.get("hub.mode")
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")

    if not META_VERIFY_TOKEN:
        if settings.environment == "production":
            raise HTTPException(status_code=500, detail="META_WEBHOOK_VERIFY_TOKEN not configured")
        # In dev, skip verification (accept any token)
        return challenge

    if token != META_VERIFY_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid verify token")

    return challenge


# --- Company-scoped endpoints (require auth) ---
@router.get("/leads")
async def list_leads(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """List leads from Meta (company-scoped)"""
    company_id = payload.get("companyId")
    
    # TODO: query leads table
    return {"leads": [], "total": 0}


@router.get("/leads/{lead_id}")
async def get_lead(
    lead_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Get lead details"""
    company_id = payload.get("companyId")
    
    # TODO: get lead from database
    return {"ok": False, "reason": "not_implemented"}
