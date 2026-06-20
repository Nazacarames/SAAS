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


def verify_meta_signature(body: bytes, signature: str, app_secret: str = "") -> bool:
    """Verify Meta webhook signature. Always enforced — no env bypass."""
    # Missing signature is always rejected
    if not signature:
        return False

    if not app_secret:
        app_secret = os.getenv("META_APP_SECRET", "")
    if not app_secret:
        # No secret configured → cannot verify → reject
        print("WARNING: META_APP_SECRET not configured - rejecting webhook")
        return False

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
        return Response(content=str(challenge), media_type="text/plain")

    if token != META_VERIFY_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid verify token")

    return Response(content=str(challenge), media_type="text/plain")


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
    except Exception:
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
        return Response(content=str(challenge), media_type="text/plain")

    if token != META_VERIFY_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid verify token")

    return Response(content=str(challenge), media_type="text/plain")


# --- Per-company webhook endpoints ---
@router.get("/meta-leads/webhook/{company_id}")
async def meta_leads_verify_company(company_id: int, req: Request, db: Session = Depends(get_db)):
    """Verify webhook for a specific company"""
    import json as _json
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")
    try:
        row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
            {"cid": company_id}
        ).mappings().first()
        s = row["settings_json"] if row and row["settings_json"] else {}
        if isinstance(s, str): s = _json.loads(s)
        company_token = s.get("metaLeadAdsWebhookVerifyToken", "")
    except Exception:
        company_token = ""
    if not company_token:
        raise HTTPException(status_code=500, detail="Verify token not configured")
    if token != company_token:
        raise HTTPException(status_code=403, detail="Invalid verify token")
    return Response(content=str(challenge), media_type="text/plain")


@router.post("/meta-leads/webhook/{company_id}")
async def meta_leads_webhook_company(company_id: int, req: Request, response: Response, db: Session = Depends(get_db)):
    """Handle Meta Leads webhook for a specific company: fetch lead from Graph API, persist, upsert contact."""
    import json as _json
    import re as _re
    import httpx as _httpx

    body = await req.body()

    # Load per-company app secret for signature verification
    _company_app_secret = ""
    try:
        _crs_row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
            {"cid": company_id}
        ).mappings().first()
        if _crs_row and _crs_row["settings_json"]:
            import json as _json_tmp
            _s = _crs_row["settings_json"]
            if isinstance(_s, str):
                _s = _json_tmp.loads(_s)
            # Prefer metaLeadAdsAppSecret; fallback to waCloudAppSecret (same Meta app)
            _company_app_secret = _s.get("metaLeadAdsAppSecret") or _s.get("waCloudAppSecret") or ""
            # Reject tokens accidentally stored as app secret (access tokens start with EAA/EAF)
            if _company_app_secret.startswith(("EAA", "EAF")):
                _company_app_secret = _s.get("waCloudAppSecret") or ""
            if _company_app_secret.startswith(("EAA", "EAF")):
                _company_app_secret = ""
    except Exception as _e:
        print(f"[meta-webhook] failed loading per-company secret company={company_id}: {_e}")

    signature = req.headers.get("x-hub-signature-256", "")
    if not verify_meta_signature(body, signature, app_secret=_company_app_secret):
        raise HTTPException(status_code=401, detail="Invalid signature")
    if not check_meta_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay"}

    try:
        payload = _json.loads(body)
    except Exception:
        return {"ok": True, "ignored": True, "reason": "invalid_json"}

    results = []
    ingested_count = 0
    graph_version = "v19.0"

    if isinstance(payload, dict) and payload.get("object") == "page" and isinstance(payload.get("entry"), list):
        for entry in payload["entry"]:
            page_id = str(entry.get("id", "")).strip()
            for change in entry.get("changes", []):
                if change.get("field") != "leadgen":
                    continue
                value = change.get("value", {})
                leadgen_id = str(value.get("leadgen_id") or value.get("lead", {}).get("id", "")).strip()
                if not leadgen_id:
                    continue

                replay_key = f"{company_id}:{leadgen_id}"
                try:
                    db.execute(text("INSERT INTO meta_lead_replay_guard (replay_key) VALUES (:k)"), {"k": replay_key})
                    db.commit()
                except Exception:
                    db.rollback()
                    results.append({"leadgen_id": leadgen_id, "ok": True, "ingested": False, "reason": "duplicate"})
                    continue

                token_row = db.execute(
                    text("SELECT access_token FROM meta_connections WHERE company_id = :cid AND page_id = :pid ORDER BY id DESC LIMIT 1"),
                    {"cid": company_id, "pid": page_id},
                ).mappings().first()
                if not token_row:
                    print(f"[meta-webhook] no page token company={company_id} page={page_id}")
                    results.append({"leadgen_id": leadgen_id, "ok": False, "reason": "no_page_token"})
                    continue
                page_token = token_row["access_token"]

                lead_data = None
                try:
                    resp = _httpx.get(
                        f"https://graph.facebook.com/{graph_version}/{leadgen_id}",
                        params={
                            "access_token": page_token,
                            "fields": "field_data,form_id,ad_id,campaign_id,adset_id,created_time",
                        },
                        timeout=10,
                    )
                    if resp.status_code == 200:
                        lead_data = resp.json()
                    else:
                        print(f"[meta-webhook] graph {leadgen_id} -> {resp.status_code} {resp.text[:200]}")
                except Exception as e:
                    print(f"[meta-webhook] graph error {leadgen_id}: {e}")

                if not lead_data:
                    results.append({"leadgen_id": leadgen_id, "ok": False, "reason": "graph_no_data"})
                    continue

                fields = {}
                for f in lead_data.get("field_data", []):
                    fname = str(f.get("name", "")).lower().strip()
                    vals = f.get("values") or []
                    if fname and vals:
                        fields[fname] = vals[0]

                contact_phone = str(fields.get("phone_number") or fields.get("phone") or fields.get("telefono") or "").strip()
                contact_email = str(fields.get("email") or fields.get("correo") or "").strip()
                contact_name = str(
                    fields.get("full_name")
                    or fields.get("name")
                    or fields.get("nombre")
                    or f"{fields.get('first_name', '')} {fields.get('last_name', '')}".strip()
                ).strip()

                db.execute(
                    text(
                        """INSERT INTO meta_lead_events
                        (company_id, page_id, form_id, leadgen_id, ad_id, campaign_id, adset_id,
                         form_fields_json, payload_json, contact_phone, contact_email, contact_name)
                        VALUES (:cid, :pid, :fid, :lid, :aid, :camp, :adset, :ff, :pl, :cp, :ce, :cn)"""
                    ),
                    {
                        "cid": company_id,
                        "pid": page_id,
                        "fid": str(lead_data.get("form_id") or value.get("form_id") or "")[:120],
                        "lid": leadgen_id,
                        "aid": str(lead_data.get("ad_id") or value.get("ad_id") or "")[:120],
                        "camp": str(lead_data.get("campaign_id") or value.get("campaign_id") or "")[:120],
                        "adset": str(lead_data.get("adset_id") or "")[:120],
                        "ff": _json.dumps(fields, ensure_ascii=False),
                        "pl": _json.dumps(lead_data, ensure_ascii=False),
                        "cp": contact_phone[:60],
                        "ce": contact_email[:160],
                        "cn": (contact_name or "Lead Meta")[:180],
                    },
                )

                if contact_phone or contact_email:
                    existing = None
                    if contact_phone:
                        clean_phone = _re.sub(r"\D", "", contact_phone)
                        existing = db.execute(
                            text(
                                r"""SELECT id FROM contacts
                                WHERE "companyId" = :cid
                                AND REGEXP_REPLACE(COALESCE(number,''), '\D', '', 'g') = :phone
                                LIMIT 1"""
                            ),
                            {"cid": company_id, "phone": clean_phone},
                        ).mappings().first()
                    if not existing and contact_email:
                        existing = db.execute(
                            text(
                                'SELECT id FROM contacts WHERE "companyId" = :cid AND LOWER(COALESCE(email,\'\')) = :em LIMIT 1'
                            ),
                            {"cid": company_id, "em": contact_email.lower()},
                        ).mappings().first()
                    if existing and contact_name:
                        # Update name if current name is digit-only (was set as phone number by WA webhook)
                        current_row = db.execute(
                            text('SELECT name FROM contacts WHERE id = :id LIMIT 1'),
                            {"id": existing["id"]},
                        ).mappings().first()
                        current_name = str(current_row["name"] or "") if current_row else ""
                        import re as _re2
                        if _re2.fullmatch(r"\d+", current_name.strip()):
                            db.execute(
                                text('UPDATE contacts SET name = :n, "updatedAt" = NOW() WHERE id = :id'),
                                {"n": contact_name[:180], "id": existing["id"]},
                            )
                    if not existing:
                        db.execute(
                            text(
                                """INSERT INTO contacts
                                (name, number, email, source, "leadStatus", "companyId", "createdAt", "updatedAt")
                                VALUES (:n, :ph, :em, 'meta_lead_ads', 'new', :cid, NOW(), NOW())"""
                            ),
                            {
                                "n": (contact_name or "Lead Meta")[:180],
                                "ph": contact_phone or None,
                                "em": contact_email or None,
                                "cid": company_id,
                            },
                        )

                db.commit()
                ingested_count += 1
                results.append({
                    "leadgen_id": leadgen_id,
                    "ok": True,
                    "ingested": True,
                    "name": contact_name,
                    "phone": contact_phone,
                    "email": contact_email,
                })

    return {"ok": True, "company_id": company_id, "events": ingested_count, "results": results}


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
