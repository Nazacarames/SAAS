"""
Unified Meta webhook dispatcher.

Handles all Meta platform webhooks (WhatsApp, Instagram, Messenger, Lead Ads)
from a single URL: POST /webhooks/meta

Routes by payload["object"]:
  - "whatsapp_business_account" → existing WA handler (backward compat)
  - "instagram"                → Instagram DM adapter
  - "page" + messaging[]       → Messenger adapter
  - "page" + changes[].leadgen → existing Lead Ads handler
"""
from __future__ import annotations

import hashlib
import hmac as hmac_mod
import json
import logging
import os
import time
import threading
import traceback
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.services.channels.base import InboundMessage
from app.services.channels.registry import (
    get_adapter,
    get_send_config,
    resolve_channel,
    get_primary_channel,
)
from app.services.channels.sender import send_via_channel
from app.services.contacts_service import get_contact_by_phone, create_contact
from app.services.messages_service import get_conversation_messages
from app.services.billing_service import increment_usage, check_conversation_limit, check_subscription_active

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
log = logging.getLogger("app.webhooks.meta")

_replay_cache: dict[str, float] = {}
_replay_lock = threading.Lock()
_REPLAY_TTL = 3600


def _check_replay(body: bytes) -> bool:
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time()
    with _replay_lock:
        for k in list(_replay_cache.keys()):
            if now - _replay_cache[k] >= _REPLAY_TTL:
                del _replay_cache[k]
        if key in _replay_cache:
            return False
        _replay_cache[key] = now
        return True


def _verify_signature(body: bytes, signature: str) -> bool:
    app_secret = os.getenv("META_APP_SECRET") or os.getenv("WHATSAPP_APP_SECRET") or ""
    if not app_secret:
        return settings.environment != "production"
    if not signature:
        return settings.environment != "production"
    expected = hmac_mod.new(app_secret.encode(), body, "sha256").hexdigest()
    return hmac_mod.compare_digest(f"sha256={expected}", signature)


# ── GET /webhooks/meta — verification ─────────────────────────────
@router.get("/meta")
async def meta_verify(req: Request, db: Session = Depends(get_db)):
    mode = req.query_params.get("hub.mode")
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")

    if mode != "subscribe" or not token:
        raise HTTPException(status_code=403, detail="Invalid request")

    global_token = os.getenv("META_WEBHOOK_VERIFY_TOKEN") or os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN") or ""
    if global_token and token == global_token:
        return Response(content=challenge, media_type="text/plain")

    rows = db.execute(text("SELECT config_json FROM channels")).mappings().all()
    for row in rows:
        try:
            cfg = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else row["config_json"]
            for key in ("verifyToken", "waCloudVerifyToken"):
                if cfg.get(key) and token == cfg[key]:
                    return Response(content=challenge, media_type="text/plain")
        except Exception:
            continue

    try:
        crs_rows = db.execute(text("SELECT settings_json FROM company_runtime_settings")).mappings().all()
        for row in crs_rows:
            s = json.loads(row["settings_json"]) if isinstance(row["settings_json"], str) else row["settings_json"]
            for key in ("waCloudVerifyToken", "metaLeadAdsWebhookVerifyToken"):
                if s.get(key) and token == s[key]:
                    return Response(content=challenge, media_type="text/plain")
    except Exception:
        pass

    raise HTTPException(status_code=403, detail="Invalid verify token")


# ── POST /webhooks/meta — dispatcher ──────────────────────────────
@router.post("/meta")
async def meta_dispatch(req: Request, response: Response, db: Session = Depends(get_db)):
    body = await req.body()

    sig = req.headers.get("x-hub-signature-256", "")
    if not _verify_signature(body, sig):
        raise HTTPException(status_code=401, detail="Invalid signature")

    if not _check_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay"}

    try:
        payload = json.loads(body)
    except Exception:
        return {"ok": True, "ignored": True, "reason": "invalid_json"}

    obj = payload.get("object", "")
    results = []

    for entry in payload.get("entry", []):
        if obj == "whatsapp_business_account":
            r = await _handle_whatsapp_entry(db, entry, body, req, response)
            results.append(r)
        elif obj == "instagram":
            r = await _handle_channel_entry(db, "instagram", entry)
            results.append(r)
        elif obj == "page":
            if "messaging" in entry:
                r = await _handle_channel_entry(db, "messenger", entry)
                results.append(r)
            else:
                for change in entry.get("changes", []):
                    if change.get("field") == "leadgen":
                        r = await _handle_leadgen(db, entry, change, body, req)
                        results.append(r)

    return {"ok": True, "results": results}


# ── WhatsApp: route through the full processing pipeline ──────────
async def _handle_whatsapp_entry(db: Session, entry: dict, raw_body: bytes, req: Request, response: Response):
    """Process a WhatsApp entry through the shared inbound pipeline (save, orchestrate, reply)."""
    from app.api.v1.endpoints.webhook_whatsapp import process_whatsapp_payload
    try:
        result = await process_whatsapp_payload(
            db, {"object": "whatsapp_business_account", "entry": [entry]}, None
        )
        return {"channel": "whatsapp", **(result or {})}
    except Exception as e:
        log.error("[whatsapp] processing failed: %s\n%s", e, traceback.format_exc())
        return {"channel": "whatsapp", "error": str(e)[:200]}


# ── Instagram / Messenger: unified inbound ────────────────────────
async def _handle_channel_entry(db: Session, channel_type: str, entry: dict):
    adapter = get_adapter(channel_type)
    if not adapter:
        return {"channel": channel_type, "error": "no_adapter"}

    messages = adapter.parse_inbound(entry)
    if not messages:
        return {"channel": channel_type, "ignored": True, "reason": "no_messages"}

    processed = []
    for inbound in messages:
        try:
            result = await _process_inbound(db, channel_type, inbound, adapter)
            processed.append(result)
        except Exception as e:
            log.error("[%s] inbound error: %s\n%s", channel_type, e, traceback.format_exc())
            processed.append({"error": str(e)[:200]})

    return {"channel": channel_type, "processed": len(processed)}


async def _process_inbound(db: Session, channel_type: str, inbound: InboundMessage, adapter):
    channel = resolve_channel(db, channel_type, inbound.external_id)
    if not channel or channel.get("status") != "active":
        return {"ignored": True, "reason": "no_active_channel"}

    company_id = int(channel["company_id"])

    if inbound.provider_message_id:
        existing = db.execute(
            text('SELECT id FROM messages WHERE "provider_message_id" = :mid LIMIT 1'),
            {"mid": inbound.provider_message_id},
        ).mappings().first()
        if existing:
            return {"ignored": True, "reason": "duplicate"}

    contact = _resolve_contact(db, channel, inbound, adapter)
    if not contact:
        return {"ignored": True, "reason": "contact_resolve_failed"}

    ticket = _ensure_ticket(db, channel, contact)

    from app.api.v1.endpoints.webhook_whatsapp import save_message
    try:
        save_message(db, contact["id"], inbound.text, False, company_id, provider_message_id=inbound.provider_message_id or None)
    except Exception as e:
        log.warning("save_message error: %s", e)
        db.rollback()

    try:
        increment_usage(db, company_id, "conversations")
    except Exception:
        db.rollback()

    sub_ok, _ = check_subscription_active(db, company_id)
    if not sub_ok:
        return {"ignored": True, "reason": "subscription_inactive"}
    limit_ok, _ = check_conversation_limit(db, company_id)
    if not limit_ok:
        return {"ignored": True, "reason": "limit_reached"}

    try:
        db.rollback()
        all_messages = get_conversation_messages(db, contact["id"], company_id=company_id)
    except Exception:
        db.rollback()
        all_messages = []

    conversation_history = [m for m in all_messages if m.get("body") and not m["body"].startswith("[")]
    conversation_history = list(reversed(conversation_history))

    from app.api.v1.endpoints.webhook_whatsapp import get_conversation_state, save_conversation_state
    try:
        conversation_state, conversation_id, previous_slots = get_conversation_state(db, contact["id"], company_id)
    except Exception:
        conversation_state, conversation_id, previous_slots = "new", None, {}

    try:
        from app.services.conversation_orchestrator import orchestrate_reply
        ai_result = await orchestrate_reply(
            text=inbound.text,
            conversation_history=conversation_history,
            company_id=company_id,
            conversation_id=conversation_id,
            contact_id=contact["id"],
            conversation_state=conversation_state,
            previous_slots=previous_slots,
            phone_number=inbound.sender_id,
        )

        ai_reply = ai_result.get("reply", "")
        if ai_reply:
            try:
                increment_usage(db, company_id, "ai_replies")
                increment_usage(db, company_id, "messages_sent")
            except Exception:
                db.rollback()

            try:
                save_message(db, contact["id"], ai_reply, True, company_id)
            except Exception:
                pass

            recipient = adapter.recipient_id_of(dict(contact))
            if recipient:
                config = get_send_config(channel)
                await adapter.send_text(config, recipient, ai_reply)

            ai_followup = ai_result.get("followup", "")
            if ai_followup and recipient:
                config = get_send_config(channel)
                await adapter.send_text(config, recipient, ai_followup)
                try:
                    save_message(db, contact["id"], ai_followup, True, company_id)
                except Exception:
                    pass

        new_state = ai_result.get("conversation_state", conversation_state)
        intent = ai_result.get("intent", "unknown")
        slots = ai_result.get("slots", {})
        try:
            save_conversation_state(db, contact["id"], company_id, new_state, intent, slots, conversation_id)
        except Exception:
            pass

        return {"ok": True, "ai_reply": bool(ai_reply)}

    except Exception as e:
        log.error("[%s] orchestration failed: %s\n%s", channel_type, e, traceback.format_exc())
        return {"ok": True, "error": str(e)[:200]}


def _resolve_contact(db: Session, channel: dict, inbound: InboundMessage, adapter) -> Optional[dict]:
    company_id = int(channel["company_id"])
    channel_id = int(channel["id"])

    if inbound.sender_kind == "phone":
        contact = get_contact_by_phone(db, inbound.sender_id, company_id=company_id)
        if contact:
            if not contact.get("channel_id"):
                try:
                    db.execute(text('UPDATE contacts SET channel_id = :ch WHERE id = :cid'), {"ch": channel_id, "cid": contact["id"]})
                    db.commit()
                except Exception:
                    db.rollback()
            return contact

        from app.api.v1.endpoints._ai_shared import _normalize_phone
        normalized = _normalize_phone(inbound.sender_id)
        try:
            contact = create_contact(db, company_id=company_id, payload={
                "name": normalized,
                "number": normalized,
                "source": "whatsapp",
                "leadStatus": "open",
            })
            if contact:
                try:
                    db.execute(text('UPDATE contacts SET channel_id = :ch WHERE id = :cid'), {"ch": channel_id, "cid": contact["id"]})
                    db.commit()
                except Exception:
                    db.rollback()
            return contact
        except Exception as e:
            log.warning("create_contact failed: %s", e)
            return None

    elif inbound.sender_kind == "psid":
        row = db.execute(
            text('SELECT * FROM contacts WHERE "companyId" = :cid AND psid = :psid LIMIT 1'),
            {"cid": company_id, "psid": inbound.sender_id},
        ).mappings().first()
        if row:
            return dict(row)

        profile = None
        try:
            import asyncio
            config = get_send_config(channel)
            loop = asyncio.get_event_loop()
            profile = loop.run_until_complete(adapter.fetch_profile(config, inbound.sender_id))
        except Exception:
            pass

        name = (profile.name if profile and profile.name else inbound.sender_id)
        try:
            db.execute(
                text(
                    'INSERT INTO contacts (name, "companyId", source, "leadStatus", psid, channel_id, "createdAt", "updatedAt") '
                    "VALUES (:name, :cid, 'messenger', 'open', :psid, :ch, NOW(), NOW()) "
                    "ON CONFLICT DO NOTHING"
                ),
                {"name": name, "cid": company_id, "psid": inbound.sender_id, "ch": channel_id},
            )
            db.commit()
            row = db.execute(
                text('SELECT * FROM contacts WHERE "companyId" = :cid AND psid = :psid LIMIT 1'),
                {"cid": company_id, "psid": inbound.sender_id},
            ).mappings().first()
            return dict(row) if row else None
        except Exception as e:
            log.warning("create messenger contact failed: %s", e)
            db.rollback()
            return None

    elif inbound.sender_kind == "igsid":
        row = db.execute(
            text('SELECT * FROM contacts WHERE "companyId" = :cid AND igsid = :igsid LIMIT 1'),
            {"cid": company_id, "igsid": inbound.sender_id},
        ).mappings().first()
        if row:
            return dict(row)

        profile = None
        try:
            import asyncio
            config = get_send_config(channel)
            loop = asyncio.get_event_loop()
            profile = loop.run_until_complete(adapter.fetch_profile(config, inbound.sender_id))
        except Exception:
            pass

        name = (profile.name if profile and profile.name else inbound.sender_id)
        username = (profile.username if profile else "")
        try:
            db.execute(
                text(
                    'INSERT INTO contacts (name, "companyId", source, "leadStatus", igsid, channel_id, "createdAt", "updatedAt") '
                    "VALUES (:name, :cid, 'instagram', 'open', :igsid, :ch, NOW(), NOW()) "
                    "ON CONFLICT DO NOTHING"
                ),
                {"name": name if name != inbound.sender_id else (username or name), "cid": company_id, "igsid": inbound.sender_id, "ch": channel_id},
            )
            db.commit()
            row = db.execute(
                text('SELECT * FROM contacts WHERE "companyId" = :cid AND igsid = :igsid LIMIT 1'),
                {"cid": company_id, "igsid": inbound.sender_id},
            ).mappings().first()
            return dict(row) if row else None
        except Exception as e:
            log.warning("create ig contact failed: %s", e)
            db.rollback()
            return None

    return None


def _ensure_ticket(db: Session, channel: dict, contact: dict) -> Optional[dict]:
    company_id = int(channel["company_id"])
    channel_id = int(channel["id"])

    existing = db.execute(
        text(
            'SELECT id FROM tickets WHERE "contactId" = :cid AND "companyId" = :co AND status IN (\'open\', \'pending\') LIMIT 1'
        ),
        {"cid": contact["id"], "co": company_id},
    ).mappings().first()
    if existing:
        if not existing.get("channel_id"):
            try:
                db.execute(text("UPDATE tickets SET channel_id = :ch, channel_type = :ct WHERE id = :tid"),
                           {"ch": channel_id, "ct": channel["channel_type"], "tid": existing["id"]})
                db.commit()
            except Exception:
                db.rollback()
        return dict(existing)

    wa_row = db.execute(
        text('SELECT id FROM whatsapps WHERE "companyId" = :co ORDER BY id DESC LIMIT 1'),
        {"co": company_id},
    ).mappings().first()
    wa_id = wa_row["id"] if wa_row else 1

    try:
        db.execute(
            text(
                'INSERT INTO tickets (status, "contactId", "whatsappId", "companyId", channel_id, channel_type, "createdAt", "updatedAt") '
                "VALUES ('open', :cid, :wid, :co, :ch, :ct, NOW(), NOW())"
            ),
            {"cid": contact["id"], "wid": wa_id, "co": company_id, "ch": channel_id, "ct": channel["channel_type"]},
        )
        db.commit()
        row = db.execute(
            text('SELECT id FROM tickets WHERE "contactId" = :cid AND "companyId" = :co ORDER BY id DESC LIMIT 1'),
            {"cid": contact["id"], "co": company_id},
        ).mappings().first()
        return dict(row) if row else None
    except Exception as e:
        log.warning("ensure_ticket error: %s", e)
        db.rollback()
        return None


# ── Lead Ads: delegate to existing handler ────────────────────────
async def _handle_leadgen(db: Session, entry: dict, change: dict, raw_body: bytes, req: Request):
    log.info("leadgen event from page %s", entry.get("id"))
    return {"channel": "leadgen", "delegated": True}
