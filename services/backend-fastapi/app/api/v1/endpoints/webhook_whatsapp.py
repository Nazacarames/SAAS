"""
WhatsApp Cloud Webhook - Handle incoming messages and process with AI Agent
Migrated from Node.js ProcessCloudWebhookService
"""
import os
import httpx
from typing import Optional
from fastapi import APIRouter, Request, HTTPException, Response, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session
import hashlib
import hmac
import time
import json
import threading
import re

from app.core.db import get_db
from app.core.config import settings
from app.services.contacts_service import get_contact_by_phone, create_contact
from app.services.messages_service import get_conversation_messages
from app.services.conversation_orchestrator import orchestrate_reply
from app.services.channels.whatsapp import (
    send_whatsapp_message as _channel_send_wa_msg,
    send_whatsapp_image as _channel_send_wa_img,
    get_whatsapp_config as _channel_get_wa_cfg,
)
from app.services.billing_service import increment_usage, check_conversation_limit, check_subscription_active
from app.services.crypto import decrypt

router = APIRouter(prefix="/whatsapp-cloud", tags=["whatsapp-webhook"])

# Thread-safe in-memory replay cache with TTL
_replay_cache: dict[str, float] = {}
_replay_cache_lock = threading.Lock()
_REPLAY_TTL_SECONDS = 3600  # 1 hour TTL


def get_conversation_state(db: Session, contact_id: int, company_id: int) -> tuple[str, Optional[int], dict]:
    """
    Get conversation state + persisted slots for a contact.
    Returns (state, conversation_id, previous_slots).
    """
    try:
        row = db.execute(
            text("""
                SELECT id, state, slots_json FROM ai_conversations
                WHERE contact_id = :contact_id AND company_id = :company_id
                ORDER BY updated_at DESC LIMIT 1
            """),
            {"contact_id": contact_id, "company_id": company_id}
        ).mappings().first()
        if row:
            prev_slots = {}
            try:
                raw_slots = row["slots_json"]
                if isinstance(raw_slots, dict):
                    prev_slots = raw_slots  # psycopg returns JSONB as dict
                elif raw_slots:
                    prev_slots = json.loads(raw_slots)
            except Exception:
                pass
            return row["state"] or "new", row["id"], prev_slots
    except Exception as e:
        print(f"[webhook] get_conversation_state error: {e}")
    return "new", None, {}


def save_conversation_state(
    db: Session,
    contact_id: int,
    company_id: int,
    state: str,
    intent: str,
    slots: dict,
    conversation_id: Optional[int] = None,
) -> Optional[int]:
    """Save or update conversation state."""
    try:
        slots_json = json.dumps(slots or {}, ensure_ascii=False)
        if conversation_id:
            db.execute(
                text("""
                    UPDATE ai_conversations
                    SET state = :state, intent = :intent, slots_json = :slots_json,
                        messages_count = messages_count + 1, updated_at = NOW()
                    WHERE id = :id
                """),
                {"id": conversation_id, "state": state, "intent": intent, "slots_json": slots_json}
            )
            db.commit()
            return conversation_id
        else:
            row = db.execute(
                text("""
                    INSERT INTO ai_conversations (company_id, contact_id, state, intent, slots_json, messages_count, created_at, updated_at)
                    VALUES (:company_id, :contact_id, :state, :intent, :slots_json, 1, NOW(), NOW())
                    RETURNING id
                """),
                {"company_id": company_id, "contact_id": contact_id, "state": state,
                 "intent": intent, "slots_json": slots_json}
            ).mappings().first()
            db.commit()
            return row["id"] if row else None
    except Exception as e:
        print(f"[webhook] save_conversation_state error: {e}")
        db.rollback()
        return None


def get_app_secret() -> str:
    """Get WhatsApp app secret from settings"""
    return os.getenv("WHATSAPP_APP_SECRET", "")


def verify_signature(req: Request, body: bytes, signature: str | None) -> bool:
    """Verify webhook signature"""
    app_secret = get_app_secret()
    if not app_secret:
        if settings.environment == "production":
            print("WARNING: WHATSAPP_APP_SECRET not configured - rejecting webhook in production")
            return False
        return True  # Skip in dev
    if not signature:
        if settings.environment == "production":
            return False
        return True

    expected = hmac.new(
        app_secret.encode(),
        body,
        "sha256"
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def check_replay(body: bytes) -> bool:
    """Check for replay attacks (thread-safe)"""
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time()

    with _replay_cache_lock:
        # Remove expired entries (TTL-based eviction)
        for k in list(_replay_cache.keys()):
            if now - _replay_cache[k] >= _REPLAY_TTL_SECONDS:
                del _replay_cache[k]

        if key in _replay_cache:
            return False

        _replay_cache[key] = now
        return True


class WebhookResponse(BaseModel):
    ok: bool = True
    ignored: bool = False
    reason: str = ""
    ai_reply: Optional[str] = None


def _extract_interactive_id(payload: dict) -> str:
    """Id de la respuesta a un botón/lista (ej: mb:o0) si el mensaje es interactivo."""
    try:
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                for msg in change.get("value", {}).get("messages", []) or []:
                    reply = (msg.get("interactive") or {}).get("button_reply") or \
                            (msg.get("interactive") or {}).get("list_reply") or {}
                    if reply.get("id"):
                        return str(reply["id"])
    except Exception:
        pass
    return ""


def _extract_profile_name(payload: dict, wa_id: str) -> str:
    """Nombre de perfil que sugiere WhatsApp (pushname) para el remitente."""
    try:
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                for c in change.get("value", {}).get("contacts", []) or []:
                    if not wa_id or str(c.get("wa_id", "")) == str(wa_id):
                        name = str((c.get("profile") or {}).get("name") or "").strip()
                        if name:
                            return name[:120]
    except Exception:
        pass
    return ""


# referral por mensaje: lo llena la extraccion y lo consume el handler
_AD_REFERRALS: dict = {}


def extract_messages_from_payload(payload: dict) -> list[tuple[str, str, str, dict | None]]:
    """Extract ALL message tuples (msg_id, from, text) from WhatsApp webhook payload.
    Status-only webhooks return empty list.
    """
    out: list[tuple[str, str, str]] = []
    try:
        entries = payload.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})

                # Ignore status-only payloads
                statuses = value.get("statuses", [])
                messages = value.get("messages", [])
                if statuses and not messages:
                    continue

                for msg in messages:
                    msg_id = msg.get("id", "")
                    from_num = msg.get("from", "")
                    # Aviso de origen (Click to WhatsApp). Meta lo adjunta solo
                    # al PRIMER mensaje: si no se guarda aca, se pierde.
                    if msg.get("referral"):
                        _AD_REFERRALS[msg_id or from_num] = msg["referral"]
                    # Traza del origen: sin esto, cuando un cliente dice "me
                    # entraron leads de pauta" no hay forma de saber a que
                    # numero llegaron ni si Meta mando el bloque del aviso.
                    import logging as _lg
                    _lg.getLogger("app.access").info(
                        "WA_IN phone_id=%s from=%s ad=%s" % (
                            value.get("metadata", {}).get("phone_number_id"),
                            from_num,
                            bool(msg.get("referral"))))
                    text_body = msg.get("text", {}).get("body", "")
                    if text_body:
                        out.append((msg_id, from_num, text_body, None))
                        continue

                    # Respuestas a botones/listas del Menú Bot: el título elegido
                    # queda como texto para que el historial se lea natural
                    if msg.get("type") == "interactive":
                        _reply = (msg.get("interactive") or {}).get("button_reply") or \
                                 (msg.get("interactive") or {}).get("list_reply") or {}
                        if _reply.get("title"):
                            out.append((msg_id, from_num, str(_reply["title"]), None))
                            continue

                    # Adjuntos: se arrastra el id de Meta para poder bajarlo.
                    # Sin esto en el panel solo queda "[image message]" y el
                    # asesor no puede ver la foto que le mandó el cliente.
                    msg_type = msg.get("type", "unknown")
                    node = msg.get(msg_type) if isinstance(msg.get(msg_type), dict) else {}
                    caption = str(node.get("caption") or "").strip()
                    media = {"id": node.get("id") or "", "type": msg_type,
                             "filename": str(node.get("filename") or "")} if node.get("id") else None
                    out.append((msg_id, from_num, caption or f"[{msg_type} message]", media))
        return out
    except Exception as e:
        print(f"extract_messages_from_payload error: {e}")
        return []


def get_whatsapp_config(db: Session, company_id: int, phone_number_id: str = None) -> Optional[dict]:
    """Get WhatsApp send config for a company.

    Prefers the active WhatsApp channel's token from meta_connections (where the
    Channels UI saves renewals); if phone_number_id is given, picks that exact
    number's channel (multi-number support). Falls back to the legacy
    company_runtime_settings blob.
    """
    import json

    # 1) Prefer the channels/meta_connections source of truth
    if phone_number_id:
        ch = db.execute(
            text("SELECT c.external_id, mc.access_token FROM channels c "
                 "JOIN meta_connections mc ON mc.id = c.meta_connection_id "
                 "WHERE c.company_id = :cid AND c.channel_type = 'whatsapp' "
                 "AND c.external_id = :pid AND COALESCE(mc.access_token,'') != '' LIMIT 1"),
            {"cid": company_id, "pid": phone_number_id},
        ).mappings().first()
        if ch:
            return {"phoneId": ch["external_id"], "token": decrypt(ch["access_token"])}

    ch = db.execute(
        text("SELECT c.external_id, mc.access_token FROM channels c "
             "JOIN meta_connections mc ON mc.id = c.meta_connection_id "
             "WHERE c.company_id = :cid AND c.channel_type = 'whatsapp' AND c.status = 'active' "
             "AND COALESCE(mc.access_token,'') != '' ORDER BY c.id LIMIT 1"),
        {"cid": company_id},
    ).mappings().first()
    if ch and ch["external_id"] and ch["access_token"]:
        return {"phoneId": ch["external_id"], "token": decrypt(ch["access_token"])}

    # 2) Legacy fallback: company_runtime_settings blob
    row = db.execute(
        text('SELECT settings_json FROM company_runtime_settings WHERE company_id = :company_id LIMIT 1'),
        {"company_id": company_id}
    ).mappings().first()
    if not row:
        return None
    settings = json.loads(row["settings_json"]) if isinstance(row["settings_json"], str) else row["settings_json"]
    phone_id = settings.get("waCloudPhoneNumberId")
    access_token = settings.get("waCloudAccessToken")
    if not phone_id or not access_token:
        return None
    return {"phoneId": phone_id, "token": access_token}


async def send_whatsapp_message(phone: str, text: str, config: dict) -> dict:
    """Send WhatsApp text message via Cloud API"""
    phone_id = config.get("phoneId")
    access_token = config.get("token")

    if not phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}

    # Trust country code from Meta webhook; only strip leading +
    phone = phone.strip().replace("+", "")

    url = f"https://graph.facebook.com/v21.0/{phone_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    payload = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "text",
        "text": {"body": text}
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers, timeout=30)
        if response.status_code in [200, 201]:
            data = response.json()
            return {
                "ok": True,
                "message_id": data.get("messages", [{}])[0].get("id")
            }
        # Retry without the mobile "9" for Argentine numbers (549XXXXXXXX -> 54XXXXXXXX)
        # Needed for dev/test mode where recipient is registered without the 9
        if response.status_code not in [200, 201] and phone.startswith("549") and len(phone) == 13:
            phone_alt = "54" + phone[3:]
            payload["to"] = phone_alt
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=headers, timeout=30)
            if response.status_code in [200, 201]:
                data = response.json()
                return {"ok": True, "message_id": data.get("messages", [{}])[0].get("id")}
        try:
            import logging as _lg
            _lg.getLogger("app.wa_send").warning(
                "wa_send_failed type=text status=%s phone_id=%s to=%s err=%s",
                response.status_code, phone_id[:6] + "..." if phone_id else "?",
                phone[:3] + "..." + phone[-3:] if len(phone) > 6 else phone,
                response.text[:200]
            )
        except Exception:
            pass
        return {"ok": False, "reason": "api_error", "error": response.text[:200], "status": response.status_code}
    except Exception as e:
        try:
            import logging as _lg
            _lg.getLogger("app.wa_send").warning(
                "wa_send_exception type=text phone_id=%s err=%s",
                phone_id[:6] + "..." if phone_id else "?", str(e)[:200]
            )
        except Exception:
            pass
        return {"ok": False, "reason": "exception", "error": str(e)}


async def send_whatsapp_image(phone: str, image_url: str, caption: str, config: dict) -> dict:
    """Send WhatsApp image message via Cloud API."""
    phone_id = config.get("phoneId")
    access_token = config.get("token")

    if not phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}

    phone = phone.strip().replace("+", "")

    url = f"https://graph.facebook.com/v21.0/{phone_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    payload = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "image",
        "image": {
            "link": image_url,
            "caption": caption[:1024] if caption else ""
        }
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=headers, timeout=30)
        if response.status_code in [200, 201]:
            data = response.json()
            return {"ok": True, "message_id": data.get("messages", [{}])[0].get("id")}
        # Retry without mobile "9" for Argentine numbers (same as text send)
        if response.status_code not in [200, 201] and phone.startswith("549") and len(phone) == 13:
            phone_alt = "54" + phone[3:]
            payload["to"] = phone_alt
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=headers, timeout=30)
            if response.status_code in [200, 201]:
                data = response.json()
                return {"ok": True, "message_id": data.get("messages", [{}])[0].get("id")}
        try:
            import logging as _lg
            _lg.getLogger("app.wa_send").warning(
                "wa_send_failed type=image status=%s phone_id=%s to=%s err=%s",
                response.status_code, phone_id[:6] + "..." if phone_id else "?",
                phone[:3] + "..." + phone[-3:] if len(phone) > 6 else phone,
                response.text[:200]
            )
        except Exception:
            pass
        return {"ok": False, "reason": "api_error", "error": response.text[:200], "status": response.status_code}
    except Exception as e:
        try:
            import logging as _lg
            _lg.getLogger("app.wa_send").warning(
                "wa_send_exception type=image phone_id=%s err=%s",
                phone_id[:6] + "..." if phone_id else "?", str(e)[:200]
            )
        except Exception:
            pass
        return {"ok": False, "reason": "exception", "error": str(e)}


def _parse_property_items(ai_reply: str) -> list[dict]:
    """Parse single-line property bundle into per-item payloads.
    Handles standard and fallback (custom prefix) formats.
    """
    if not ai_reply:
        return []
    CARD_SEP = " ||| "
    has_cards = CARD_SEP in ai_reply or "[FOTO:" in ai_reply
    if not has_cards:
        return []
    # Find where cards start: look for first 📍 emoji
    pin = chr(0x1F4CD)
    card_start = ai_reply.find(pin)
    if card_start >= 0:
        body = ai_reply[card_start:]
    elif ai_reply.lower().startswith("te paso opciones concretas:"):
        body = ai_reply.split(":", 1)[1].strip()
    else:
        return []
    raw_items = [x.strip() for x in body.split(CARD_SEP) if x.strip()]
    items = []
    for it in raw_items:
        photo = None
        m = re.search(r"\[FOTO:(https?://[^\]]+)\]", it)
        if m:
            photo = m.group(1)
            it = re.sub(r"\s*\[FOTO:https?://[^\]]+\]", "", it).strip()
        items.append({"text": it, "photo": photo})
    return items


def _ensure_ticket_for_contact(db: Session, contact_id: int, company_id: int) -> int | None:
    """Return an open ticket id for (contact, company), creating one if missing."""
    existing = db.execute(
        text('SELECT id FROM tickets WHERE "contactId" = :c AND "companyId" = :co ORDER BY id DESC LIMIT 1'),
        {"c": contact_id, "co": company_id},
    ).mappings().first()
    if existing:
        return int(existing["id"])
    wa = db.execute(
        text('SELECT id FROM whatsapps WHERE "companyId" = :co ORDER BY id DESC LIMIT 1'),
        {"co": company_id},
    ).mappings().first()
    # whatsappId puede ir NULL: las empresas conectadas por el wizard de Canales
    # no tienen fila en la tabla vieja whatsapps. Antes se cortaba acá y NUNCA
    # se creaba el ticket, asi que esas empresas no tenian conversaciones.
    created = db.execute(
        text('INSERT INTO tickets (status, "contactId", "whatsappId", "companyId", "createdAt", "updatedAt") '
             'VALUES (:status, :c, :w, :co, NOW(), NOW()) RETURNING id'),
        {"status": "open", "c": contact_id, "w": int(wa["id"]) if wa else None, "co": company_id},
    ).mappings().first()
    return int(created["id"]) if created else None


async def burst_superseded(db: Session, contact_id: int, seconds: float = 3.0) -> bool:
    """True si mientras esperábamos llegó otro mensaje del mismo contacto.

    El cliente manda ocho fotos y Meta dispara ocho webhooks en paralelo: sin
    esto el agente contestaba una vez por foto (y seguía contestando después de
    derivar). Con la espera corta, solo el último mensaje de la ráfaga responde;
    los demás ya están guardados, así que la respuesta los ve a todos.
    """
    import asyncio

    # por cantidad y no por MAX(id): messages.id es UUID, no es ordenable
    q = text('SELECT COUNT(*) FROM messages WHERE "contactId" = :c AND "fromMe" = false')
    try:
        before = int(db.execute(q, {"c": contact_id}).scalar() or 0)
        db.commit()
    except Exception:
        db.rollback()
        return False

    await asyncio.sleep(seconds)

    try:
        db.rollback()  # snapshot nuevo: si no, se relee lo mismo
        after = int(db.execute(q, {"c": contact_id}).scalar() or 0)
        db.commit()
    except Exception:
        db.rollback()
        return False
    return after > before


def save_message(db: Session, contact_id: int, body: str, from_me: bool, company_id: int, provider_message_id: str = None,
                 media_url: str = "", media_type: str = "") -> dict:
    """Save message to database. Ensures a ticket row exists for the contact.

    Insert is idempotent on provider_message_id (unique partial index): a
    concurrent Meta retry that races past the SELECT dedup check hits the
    ON CONFLICT clause and gets the already-saved row back instead of a dupe.
    """
    ticket_id = None
    try:
        ticket_id = _ensure_ticket_for_contact(db, contact_id, company_id)
    except Exception as _e:
        print(f"[save_message] Ticket ensure failed: {_e}")
    row = db.execute(
        text(
            'INSERT INTO messages (body, "fromMe", "contactId", "ticketId", "provider_message_id", "mediaUrl", "mediaType", "createdAt", "updatedAt") '
            'VALUES (:body, :from_me, :contact_id, :ticket_id, :pmid, :murl, :mtype, NOW(), NOW()) '
            'ON CONFLICT ("provider_message_id") WHERE "provider_message_id" IS NOT NULL DO NOTHING '
            'RETURNING id, body, "fromMe", "contactId", "ticketId"'
        ),
        {"body": body, "from_me": from_me, "contact_id": contact_id, "ticket_id": ticket_id, "pmid": provider_message_id,
         "murl": media_url or None, "mtype": media_type or None}
    ).mappings().first()
    db.commit()
    if row is None and provider_message_id:
        prior = db.execute(
            text('SELECT id, body, "fromMe", "contactId", "ticketId" FROM messages WHERE "provider_message_id" = :pmid LIMIT 1'),
            {"pmid": provider_message_id},
        ).mappings().first()
        return dict(prior) if prior else {}
    return dict(row) if row else {}


@router.post("/webhook", response_model=WebhookResponse)
async def whatsapp_webhook(req: Request, response: Response, db: Session = Depends(get_db)):
    """Handle incoming WhatsApp messages"""
    body = await req.body()

    # Signature verification
    signature = req.headers.get("x-hub-signature-256", "")
    if not verify_signature(req, body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Replay protection (in-memory, best-effort per worker)
    if not check_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay_blocked", "ai_reply": None}

    # Parse payload
    try:
        payload = json.loads(body)
    except Exception:
        return {"ok": True, "ignored": True, "reason": "invalid_json", "ai_reply": None}

    return await process_whatsapp_payload(db, payload, response)


async def process_whatsapp_payload(db: Session, payload: dict, response: Response = None) -> dict:
    """Core WhatsApp inbound processing - shared by endpoint and unified dispatcher."""
    extracted_messages = extract_messages_from_payload(payload)
    if not extracted_messages:
        return {"ok": True, "ignored": True, "reason": "no_text_message", "ai_reply": None}

    # Filter out messages we already processed (Meta retries). Each remaining
    # message in the batch is saved; their texts are combined so the AI answers
    # the full batch in one reply instead of silently dropping messages 2..N.
    new_messages = []
    for _mid, _from, _text, _media in extracted_messages:
        if _mid:
            try:
                existing = db.execute(
                    text('SELECT id FROM messages WHERE "provider_message_id" = :mid LIMIT 1'),
                    {"mid": _mid}
                ).mappings().first()
                if existing:
                    continue
            except Exception as _dup_err:
                print(f"[webhook] dedup check error (non-fatal): {_dup_err}")
        new_messages.append((_mid, _from, _text, _media))

    if not new_messages:
        if response is not None:
            response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "msg_id_already_processed", "ai_reply": None}

    # All batch messages come from the same sender; use the first for routing
    msg_id, from_number, message_text, _ = new_messages[0]
    if len(new_messages) > 1:
        message_text = "\n".join(m[2] for m in new_messages if m[2])
        print(f"[webhook] batch of {len(new_messages)} new messages combined for one reply")

    # Derive company_id from WhatsApp phone_number_id BEFORE contact lookup
    # This ensures we always scope the contact search to the correct tenant
    _incoming_company_id = None
    _incoming_channel_id = None
    try:
        _phone_number_id = payload.get("entry", [{}])[0].get("changes", [{}])[0].get("value", {}).get("metadata", {}).get("phone_number_id", "")
        if _phone_number_id:
            # La tabla channels es la fuente de verdad: una empresa puede tener
            # VARIOS números de WhatsApp. company_runtime_settings solo guarda
            # uno (el último conectado), así que buscando ahí primero se caían
            # los mensajes de todos los demás números.
            _ch_row = db.execute(
                text("SELECT id, company_id FROM channels WHERE channel_type = 'whatsapp' "
                     "AND external_id = :pid AND status = 'active' LIMIT 1"),
                {"pid": _phone_number_id},
            ).mappings().first()
            if _ch_row:
                _incoming_company_id = int(_ch_row["company_id"])
                _incoming_channel_id = int(_ch_row["id"])
            else:
                _crs_row = db.execute(
                    text("SELECT company_id FROM company_runtime_settings WHERE settings_json::jsonb ->> 'waCloudPhoneNumberId' = :pid LIMIT 1"),
                    {"pid": _phone_number_id},
                ).mappings().first()
                if _crs_row:
                    _incoming_company_id = int(_crs_row["company_id"])
    except Exception as _cid_err:
        print(f"[webhook] company_id detection error (non-fatal): {_cid_err}")

    # Find or auto-create contact, scoped to the correct company
    pushname = _extract_profile_name(payload, from_number)
    contact = get_contact_by_phone(db, from_number, company_id=_incoming_company_id)
    if contact and pushname:
        # Si el nombre actual nunca fue personalizado (vacío o solo el número),
        # adoptar el nombre que sugiere WhatsApp. Nombres editados no se tocan.
        _current = str(contact.get("name") or "").strip()
        if (not _current or re.fullmatch(r"[\d\s+\-]+", _current)) and _current != pushname:
            try:
                db.execute(
                    text('UPDATE contacts SET name = :n, "updatedAt" = NOW() WHERE id = :id'),
                    {"n": pushname, "id": contact["id"]},
                )
                db.commit()
                contact["name"] = pushname
            except Exception:
                db.rollback()
    if not contact:
        if not _incoming_company_id:
            # Cannot determine which tenant this message belongs to — drop it
            print(f"[webhook] WARN: no company found for phone_number_id, dropping message from {from_number}")
            return {"ok": True, "ignored": True, "reason": "unknown_company", "ai_reply": None}
        try:
            from app.api.v1.endpoints._ai_shared import _normalize_phone
            normalized_phone = _normalize_phone(from_number)
            contact = create_contact(db, company_id=_incoming_company_id, payload={
                "name": pushname or normalized_phone,
                "number": normalized_phone,
                "source": "whatsapp",
                "leadStatus": "open",
            })
            print(f"[webhook] Auto-created contact for {from_number}: id={contact.get('id')} company={_incoming_company_id}")
        except Exception as e:
            print(f"[webhook] Could not auto-create contact for {from_number}: {e}")
            return {"ok": True, "ignored": True, "reason": "contact_create_failed", "ai_reply": None}

    company_id = contact.get("companyId") or _incoming_company_id
    if company_id:
        # Todo lead entra con dueño (round-robin), sin esperar a que lo derive
        # el bot o la IA: así cada asesor ve los suyos en su usuario del CRM
        try:
            from app.services.handoff import ensure_assigned
            ensure_assigned(db, int(company_id), int(contact["id"]))
        except Exception:
            db.rollback()
    if not company_id:
        print(f"[webhook] WARN: could not resolve company_id for contact {contact.get('id')}, dropping")
        return {"ok": True, "ignored": True, "reason": "unknown_company", "ai_reply": None}
    company_id = int(company_id)

    # Save every incoming message in the batch (each with its own provider id)
    for _mid, _from, _text, _media in new_messages:
        try:
            _url = _mtype = ""
            if _media:
                try:
                    from app.services.media_store import download_meta_media
                    _wa = get_whatsapp_config(db, company_id, _phone_number_id or None)
                    got = download_meta_media(_media["id"], (_wa or {}).get("token", ""), int(company_id))
                    _url, _mtype = got.get("url", ""), got.get("kind", "")
                except Exception as _me:
                    print(f"[webhook] media download failed: {_me}")
            save_message(db, contact["id"], _text, False, company_id, provider_message_id=_mid or None,
                         media_url=_url, media_type=_mtype)
        except Exception as e:
            print(f"Error saving incoming message: {e}")
            db.rollback()

    # Track usage
    try:
        increment_usage(db, company_id, "conversations")
    except Exception:
        db.rollback()

    # Check subscription and limits
    sub_ok, sub_msg = check_subscription_active(db, company_id)
    if not sub_ok:
        return {"ok": True, "ignored": True, "reason": "subscription_inactive", "ai_reply": None}

    limit_ok, limit_msg = check_conversation_limit(db, company_id)
    if not limit_ok:
        return {"ok": True, "ignored": True, "reason": "limit_reached", "ai_reply": None}

    # Menú Bot determinístico: si está habilitado y maneja este mensaje
    # (botón, lista o saludo de sesión nueva), la IA no interviene
    try:
        from app.services.menu_bot import handle_inbound as _menu_bot_handle
        _wa_cfg = get_whatsapp_config(db, company_id, _phone_number_id or None)
        _mb = await _menu_bot_handle(
            db, company_id, dict(contact), message_text,
            _extract_interactive_id(payload), _wa_cfg or {},
            channel_id=_incoming_channel_id,
        )
        if _mb.get("handled"):
            # El lead del bot también se puntúa y describe: antes quedaba en 0%
            # y "Sin conversación" justo cuando pedía un asesor
            try:
                from app.services.lead_enrichment import enrich_inbound
                enrich_inbound(db, company_id, int(contact["id"]), message_text, _mb.get("choice", ""))
            except Exception:
                db.rollback()
            return {"ok": True, "ignored": False, "reason": "menu_bot", "ai_reply": None}
    except Exception as _mb_err:
        print(f"[webhook] menu bot error (non-fatal): {_mb_err}")
        db.rollback()

    # Lead que llega desde un aviso: saludo + ficha de la propiedad del aviso.
    # Va ANTES del bot y del agente: el cliente ya eligio una propiedad puntual,
    # hacerle el cuestionario de "en que zona buscas" es hacerlo repetir.
    _ref_raw = _AD_REFERRALS.pop(msg_id, None) or _AD_REFERRALS.pop(from_number, None)
    # Se dispara con el PRIMER mensaje del contacto, traiga o no el bloque de
    # Meta. El referral no siempre llega (sobre todo si el numero se atiende
    # tambien desde el celular), pero el aviso abre el chat con un mensaje ya
    # escrito que nombra la propiedad: ese texto alcanza para reconocerla.
    _es_primero = False
    try:
        _es_primero = int(db.execute(
            text('SELECT COUNT(*) FROM messages WHERE "contactId" = :i AND "fromMe" = false'),
            {"i": contact["id"]}).scalar() or 0) <= len(new_messages)
    except Exception:
        db.rollback()
    if _ref_raw or _es_primero:
        try:
            from app.services import ad_referral
            ref = ad_referral.extract_referral({"referral": _ref_raw}) if _ref_raw else {}
            _inmo = ad_referral.is_real_estate(db, company_id)
            prop = None
            if _inmo:
                prop = (await ad_referral.match_property(db, company_id, ref) if ref
                        else await ad_referral.match_by_text(db, company_id, message_text))
            # Sin aviso de Meta y sin propiedad reconocida no se interrumpe:
            # es una consulta normal y la atiende el agente como siempre.
            if ref or prop:
                if ref.get("ad_id"):
                    # El aviso va en sus propias columnas: antes se metia en
                    # `source` y pisaba el canal por el que entro el lead.
                    from app.services import ad_attribution
                    ad_attribution.save(db, company_id, int(contact["id"]), ref["ad_id"])
                _wa = get_whatsapp_config(db, company_id, _phone_number_id or None)
                if _wa:
                    _marca = db.execute(text("SELECT name FROM companies WHERE id = :c"),
                                        {"c": company_id}).scalar() or ""
                    saludo = ad_referral.welcome_text(ref, _marca, prop)
                    await send_whatsapp_message(from_number, saludo, _wa)
                    save_message(db, contact["id"], saludo, True, company_id)

                    if prop:
                        ficha = ad_referral.property_card(prop)
                        for item in _parse_property_items(ficha):
                            if item.get("photo"):
                                await send_whatsapp_image(from_number, item["photo"], item["text"], _wa)
                            else:
                                await send_whatsapp_message(from_number, item["text"], _wa)
                            save_message(db, contact["id"], item["text"], True, company_id)
                        cierre = "¿Querés que te cuente más de esta o preferís ver otras opciones parecidas?"
                    else:
                        cierre = "Contame qué estás buscando y te paso las opciones que mejor encajen."
                    await send_whatsapp_message(from_number, cierre, _wa)
                    save_message(db, contact["id"], cierre, True, company_id)
                    return {"ok": True, "ignored": False, "reason": "ad_referral",
                            "ai_reply": saludo, "propiedad": (prop or {}).get("id")}
        except Exception as e:
            print(f"[webhook] ad referral: {e}")
            db.rollback()

    # Ráfaga: una sola respuesta para todo el bloque de mensajes seguidos
    if await burst_superseded(db, int(contact["id"])):
        return {"ok": True, "ignored": True, "reason": "burst_superseded", "ai_reply": None}

    # Respuesta al seguimiento del asesor. Va ANTES del corte por ai_paused:
    # el lead derivado está pausado justamente porque lo atiende una persona, y
    # sin esto su «sí pude / no pude» no se leería nunca.
    try:
        from app.services import followup_asesor
        _fu = await followup_asesor.handle_reply(db, company_id, int(contact["id"]), message_text)
        if _fu:
            return {"ok": True, "ignored": False, "reason": "followup_asesor",
                    "ai_reply": _fu.get("respuesta")}
    except Exception as e:
        print(f"[webhook] followup asesor: {e}")
        db.rollback()

    # Handoff a humano: la IA queda pausada para este contacto
    # (se relee DESPUÉS de la espera: la derivación puede haberla activado recién)
    try:
        if db.execute(text("SELECT ai_paused FROM contacts WHERE id = :id"), {"id": contact["id"]}).scalar():
            # sigue siendo un lead vivo: puntuarlo aunque conteste un humano
            try:
                from app.services.lead_enrichment import enrich_inbound
                enrich_inbound(db, company_id, int(contact["id"]), message_text)
            except Exception:
                db.rollback()
            return {"ok": True, "ignored": False, "reason": "ai_paused", "ai_reply": None}
    except Exception:
        db.rollback()

    # El agente puede estar limitado a ciertos canales
    try:
        from app.services.knowledge_base import agent_answers_channel
        if not agent_answers_channel(company_id, _incoming_channel_id):
            return {"ok": True, "ignored": True, "reason": "agent_channel_off", "ai_reply": None}
    except Exception:
        pass

    # Get conversation history scoped to this company's contact
    try:
        db.rollback()  # Clear any aborted transaction state
        all_messages = get_conversation_messages(db, contact["id"], company_id=company_id)
    except Exception as e:
        print(f"Error getting conversation history: {e}")
        db.rollback()
        all_messages = []
    # Include BOTH user and bot messages for full conversation context
    # (filtering only user messages caused the bot to repeat greetings/questions)
    conversation_history = [
        m for m in all_messages
        if m.get("body")
        and not m["body"].startswith("[")  # Exclude "[xxx message]" types
    ]
    # Reverse to chronological order (oldest first)
    conversation_history = list(reversed(conversation_history))
    
    # Load conversation state + persisted slots for state machine persistence
    try:
        conversation_state, conversation_id, previous_slots = get_conversation_state(db, contact["id"], company_id)
    except Exception as e:
        print(f"[webhook] Error loading conversation state: {e}")
        conversation_state = "new"
        conversation_id = None
        previous_slots = {}
    
    # Process through Orchestrator (with state machine + tools)
    try:
        # Get company name from database for proper multi-tenant AI configuration
        company_name = "Default"
        try:
            company_row = db.execute(
                text('SELECT name FROM companies WHERE id = :company_id LIMIT 1'),
                {"company_id": company_id}
            ).mappings().first()
            if company_row:
                company_name = company_row["name"]
        except Exception:
            pass

        # Get WhatsApp config early (needed for sending replies)
        wa_config = get_whatsapp_config(db, company_id, _phone_number_id if "_phone_number_id" in dir() else None)

        # Load wait message config (will be sent only if property cards are returned)
        _wait_msg = ""
        try:
            from app.services.knowledge_base import get_ai_agent_config as _get_cfg
            _wait_msg = _get_cfg(company_id).get("search_wait_msg", "")
        except Exception:
            pass

        # Use orchestrate_reply instead of generate_reply for full pipeline
        ai_result = await orchestrate_reply(
            text=message_text,
            conversation_history=conversation_history,
            company_id=company_id,
            conversation_id=conversation_id,
            contact_id=contact["id"],
            conversation_state=conversation_state,
            previous_slots=previous_slots,
            phone_number=from_number,
        )
        
        ai_reply = ai_result.get("reply", "")
        if ai_reply:
            try:
                increment_usage(db, company_id, "ai_replies")
                increment_usage(db, company_id, "messages_sent")
            except Exception:
                db.rollback()
        ai_followup = ai_result.get("followup", "")
        new_conversation_state = ai_result.get("conversation_state", conversation_state)
        intent = ai_result.get("intent", "unknown")
        slots = ai_result.get("slots", {})
        
        if ai_reply:
            # Save AI reply
            try:
                save_message(db, contact["id"], ai_reply, True, company_id)
            except Exception as e:
                print(f"Error saving AI reply: {e}")
            
            # Send reply via WhatsApp (wa_config already fetched above)
            if wa_config:
                prop_items = _parse_property_items(ai_reply)
                if prop_items:
                    # Send wait message right before property cards (only for fresh searches, not cache)
                    if _wait_msg and not ai_result.get('from_cache'):
                        await send_whatsapp_message(from_number, _wait_msg, wa_config)

                    # Carrusel nativo si la inmobiliaria tiene la plantilla
                    # aprobada. Si no está aprobada o alguna propiedad no tiene
                    # foto, se mandan las fichas de siempre: nadie se queda sin
                    # ver las opciones por esperar a Meta.
                    _carousel_ok = False
                    try:
                        from app.services import wa_carousel
                        _props = (slots or {}).get("_results_cache") or []
                        if _props and wa_carousel.is_ready(db, company_id):
                            _res = wa_carousel.send_carousel(db, company_id, from_number, _props, wa_config)
                            _carousel_ok = bool(_res.get("ok"))
                            import logging as _lg
                            _lg.getLogger("app.access").info(
                                "WA_CAROUSEL ok=%s %s" % (_carousel_ok, str(_res.get("error", ""))[:120]))
                    except Exception as _ce:
                        print(f"[webhook] carrusel: {_ce}")

                    for item in ([] if _carousel_ok else prop_items):
                        if item.get("photo"):
                            send_result = await send_whatsapp_image(from_number, item["photo"], item["text"], wa_config)
                            import logging as _logging; _logging.getLogger("app.access").info(f"WA_CARD_IMAGE ok={send_result.get('ok')} err={send_result.get('error','')[:80]}")
                        else:
                            send_result = await send_whatsapp_message(from_number, item["text"], wa_config)
                            import logging as _logging; _logging.getLogger("app.access").info(f"WA_CARD_TEXT ok={send_result.get('ok')} err={send_result.get('error','')[:80]} txt_len={len(item.get('text',''))}")
                    # Followup AFTER all cards are sent
                    if ai_followup:
                        import asyncio; await asyncio.sleep(1)  # ensure ordering
                        await send_whatsapp_message(from_number, ai_followup, wa_config)
                        try:
                            save_message(db, contact["id"], ai_followup, True, company_id)
                        except Exception:
                            pass
                else:
                    send_result = await send_whatsapp_message(from_number, ai_reply, wa_config)
                    print(f"WhatsApp send result: {send_result}")
                    # Followup for non-card replies
                    if ai_followup:
                        await send_whatsapp_message(from_number, ai_followup, wa_config)
                        try:
                            save_message(db, contact["id"], ai_followup, True, company_id)
                        except Exception:
                            pass
        
        # Persist conversation state
        try:
            save_conversation_state(
                db, contact["id"], company_id,
                new_conversation_state, intent, slots, conversation_id
            )
        except Exception as e:
            print(f"[webhook] Error saving conversation state: {e}")
        
        print(f"[webhook] Orchestrator result: state={new_conversation_state}, intent={intent}, tool_calls={ai_result.get('toolCallCount', 0)}")
        
        return {
            "ok": True,
            "ignored": False,
            "reason": "",
            "ai_reply": ai_reply
        }
        
    except Exception as e:
        # The incoming message was already persisted above; only the AI reply
        # failed. Log loudly so the failure is visible in journalctl instead of
        # being silently swallowed.
        import logging, traceback
        logging.getLogger("app.access").error(
            f"[webhook] orchestration failed for contact={contact.get('id')} company={company_id}: {e}\n{traceback.format_exc()}"
        )
        return {
            "ok": True,
            "ignored": False,
            "reason": f"error: {str(e)}",
            "ai_reply": None
        }


@router.get("/webhook")
async def whatsapp_webhook_verify(req: Request, db: Session = Depends(get_db)):
    """Verify webhook for WhatsApp Cloud API"""
    import json as _json2
    mode = req.query_params.get("hub.mode")
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")

    if mode != "subscribe" or not token:
        raise HTTPException(status_code=403, detail="Invalid request")

    # 1. Check env vars (both names for backwards compat)
    env_token = os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN") or os.getenv("META_WEBHOOK_VERIFY_TOKEN") or ""
    if env_token and token == env_token:
        return Response(content=challenge, media_type="text/plain")

    # 2. Check per-company DB tokens (waCloudVerifyToken stored in company_runtime_settings)
    try:
        from sqlalchemy import text as _text2
        rows = db.execute(_text2("SELECT settings_json FROM company_runtime_settings")).mappings().all()
        for row in rows:
            if not row.get("settings_json"):
                continue
            s = row["settings_json"] if isinstance(row["settings_json"], dict) else _json2.loads(row["settings_json"])
            db_token = s.get("waCloudVerifyToken", "")
            if db_token and token == db_token:
                return Response(content=challenge, media_type="text/plain")
    except Exception:
        pass

    raise HTTPException(status_code=403, detail="Invalid verify token")
