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


def _channel_app_secrets() -> list[str]:
    """Secretos de apps de Meta propias de clientes (config_json.appSecret).

    Permite que un cliente cuyo número está tomado por otro proveedor apunte
    el webhook de SU app a este CRM: la firma viene con el secreto de esa app,
    no con el nuestro."""
    from app.services.cache import get_or_set

    def _load():
        from app.core.db import SessionLocal
        db = SessionLocal()
        try:
            out = []
            for r in db.execute(text("SELECT config_json FROM channels WHERE status = 'active'")).mappings():
                raw = r["config_json"]
                cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
                s = str(cfg.get("appSecret") or "").strip()
                if s and s not in out:
                    out.append(s)
            return out
        except Exception:
            return []
        finally:
            db.close()

    return get_or_set("channel_app_secrets", 120, _load)


def _verify_signature(body: bytes, signature: str) -> bool:
    app_secret = os.getenv("META_APP_SECRET") or os.getenv("WHATSAPP_APP_SECRET") or ""
    if not app_secret:
        return settings.environment != "production"
    if not signature:
        return settings.environment != "production"
    for secret in [app_secret, *_channel_app_secrets()]:
        expected = hmac_mod.new(secret.encode(), body, "sha256").hexdigest()
        if hmac_mod.compare_digest(f"sha256={expected}", signature):
            return True
    return False


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
            if entry.get("messaging"):
                r = await _handle_channel_entry(db, "instagram", entry)
                results.append(r)
            for change in entry.get("changes", []):
                if change.get("field") == "comments":
                    r = await _handle_comment(db, "instagram", entry, change)
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
                    elif change.get("field") == "feed":
                        r = await _handle_comment(db, "messenger", entry, change)
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
def _referrals_de(entry: dict) -> dict:
    """Id del aviso por remitente. Meta lo manda pegado al primer mensaje (o en
    un evento `referral` suelto) y no vuelve a mandarlo nunca más, así que hay
    que leerlo del payload crudo: el adaptador solo devuelve texto y adjunto."""
    salida: dict[str, str] = {}
    for m in (entry.get("messaging") or []):
        ref = m.get("referral") or (m.get("message") or {}).get("referral") or {}
        ad_id = str((ref or {}).get("ad_id") or (ref or {}).get("source_id") or "")
        remitente = str(((m.get("sender") or {}).get("id") or ""))
        if ad_id and remitente:
            salida[remitente] = ad_id
    return salida


async def _handle_channel_entry(db: Session, channel_type: str, entry: dict):
    adapter = get_adapter(channel_type)
    if not adapter:
        return {"channel": channel_type, "error": "no_adapter"}

    messages = adapter.parse_inbound(entry)
    if not messages:
        return {"channel": channel_type, "ignored": True, "reason": "no_messages"}

    avisos = _referrals_de(entry)

    processed = []
    for inbound in messages:
        try:
            result = await _process_inbound(db, channel_type, inbound, adapter, avisos)
            processed.append(result)
        except Exception as e:
            log.error("[%s] inbound error: %s\n%s", channel_type, e, traceback.format_exc())
            processed.append({"error": str(e)[:200]})

    return {"channel": channel_type, "processed": len(processed)}


def _placeholder_name(channel_type: str, sender_id: str) -> str:
    """Nombre provisorio legible mientras Meta no da el perfil.

    El nombre real necesita pages_messaging con acceso avanzado (App Review).
    Hasta entonces Meta responde "(#3) Application does not have the capability",
    y mostrar el id crudo de 17 digitos no le sirve a nadie: no se distinguen
    entre si de un vistazo.
    """
    etiqueta = "Instagram" if channel_type == "instagram" else "Messenger"
    return "%s ...%s" % (etiqueta, str(sender_id)[-6:])


async def _refresh_display_name(db, adapter, channel: dict, contact: dict, sender_id: str) -> dict:
    """Si el contacto quedo guardado con el id de Meta como nombre, reintenta
    traer el perfil y lo corrige.

    El nombre solo se pedia al crear el contacto: si ese primer pedido fallaba
    (token recien renovado, perfil no disponible todavia), el lead quedaba
    llamandose 1234567890123 para siempre.
    """
    actual = str(contact.get("name") or "").strip()
    provisorio = (not actual or actual == str(sender_id)
                  or actual.startswith("Messenger ...") or actual.startswith("Instagram ..."))
    if not provisorio:
        return contact
    try:
        profile = await adapter.fetch_profile(get_send_config(channel), sender_id)
    except Exception:
        return contact
    # en Instagram el @usuario es lo unico que Meta deja leer sin acceso
    # avanzado, y alcanza para reconocer al cliente
    _u = str(getattr(profile, "username", "") or "").strip()
    nuevo = (str(getattr(profile, "name", "") or "").strip()
             or (("@" + _u) if _u else ""))
    if not nuevo or nuevo == str(sender_id):
        return contact
    try:
        db.execute(text('UPDATE contacts SET name = :n, "updatedAt" = NOW() WHERE id = :i'),
                   {"n": nuevo[:255], "i": contact["id"]})
        db.commit()
        contact = dict(contact)
        contact["name"] = nuevo
    except Exception:
        db.rollback()
    return contact


async def _process_inbound(db: Session, channel_type: str, inbound: InboundMessage, adapter,
                           avisos: dict | None = None):
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

    contact = await _resolve_contact(db, channel, inbound, adapter)
    if not contact:
        return {"ignored": True, "reason": "contact_resolve_failed"}

    # De qué aviso vino, si vino de uno
    _ad = (avisos or {}).get(str(getattr(inbound, "sender_id", "") or ""), "")
    if _ad:
        try:
            from app.services import ad_attribution
            ad_attribution.save(db, company_id, int(contact["id"]), _ad)
        except Exception as e:
            log.warning("atribucion: %s", str(e)[:120])
            db.rollback()

    # Instagram y Messenger también reparten por round-robin: el asesor ve el
    # lead en su usuario apenas entra, sin importar por dónde llegó
    try:
        from app.services.handoff import ensure_assigned
        ensure_assigned(db, company_id, int(contact["id"]))
    except Exception:
        db.rollback()

    ticket = _ensure_ticket(db, channel, contact)

    from app.api.v1.endpoints.webhook_whatsapp import save_message
    try:
        # el adjunto se baja y se guarda: la URL que manda Meta vence y despues
        # el asesor ve un placeholder en vez de la foto
        _url = _kind = ""
        if getattr(inbound, "media_url", ""):
            try:
                from app.services.media_store import download_direct_url
                got = download_direct_url(inbound.media_url, int(company_id))
                _url, _kind = got.get("url", ""), got.get("kind", "")
            except Exception as _me:
                log.warning("media download: %s", str(_me)[:120])
        save_message(db, contact["id"], inbound.text, False, company_id,
                     provider_message_id=inbound.provider_message_id or None,
                     media_url=_url, media_type=_kind or (inbound.media_type or ""))
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

    # Score, fase y descripción también para IG/Messenger
    try:
        from app.services.lead_enrichment import enrich_inbound
        enrich_inbound(db, company_id, int(contact["id"]), inbound.text or "")
    except Exception:
        db.rollback()

    # Ráfaga: una sola respuesta para todo el bloque de mensajes seguidos
    from app.api.v1.endpoints.webhook_whatsapp import burst_superseded
    if await burst_superseded(db, int(contact["id"])):
        return {"ignored": True, "reason": "burst_superseded"}

    # Respuesta al seguimiento del asesor, antes del corte por ai_paused
    try:
        from app.services import followup_asesor
        _fu = await followup_asesor.handle_reply(db, company_id, int(contact["id"]), inbound.text or "")
        if _fu:
            return {"ignored": False, "reason": "followup_asesor"}
    except Exception as e:
        log.warning("followup asesor: %s", str(e)[:150])
        db.rollback()

    # Handoff a humano: sin esto el agente seguía contestando en IG/Messenger
    # aunque el lead ya estuviera derivado o el operador hubiera apagado el bot
    try:
        if db.execute(text("SELECT ai_paused FROM contacts WHERE id = :id"), {"id": contact["id"]}).scalar():
            return {"ignored": True, "reason": "ai_paused"}
    except Exception:
        db.rollback()

    # El agente puede estar limitado a ciertos canales
    try:
        from app.services.knowledge_base import agent_answers_channel
        if not agent_answers_channel(company_id, channel.get("id")):
            return {"ignored": True, "reason": "agent_channel_off"}
    except Exception:
        pass

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


async def _resolve_contact(db: Session, channel: dict, inbound: InboundMessage, adapter) -> Optional[dict]:
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
            return await _refresh_display_name(db, adapter, channel, dict(row), inbound.sender_id)

        profile = None
        try:
            config = get_send_config(channel)
            profile = await adapter.fetch_profile(config, inbound.sender_id)
        except Exception:
            pass

        name = (profile.name if profile and profile.name else _placeholder_name("messenger", inbound.sender_id))
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
            return await _refresh_display_name(db, adapter, channel, dict(row), inbound.sender_id)

        profile = None
        try:
            config = get_send_config(channel)
            profile = await adapter.fetch_profile(config, inbound.sender_id)
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
                {"name": (name if name != inbound.sender_id else (username or _placeholder_name("instagram", inbound.sender_id))),
                 "cid": company_id, "igsid": inbound.sender_id, "ch": channel_id},
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
    # NULL, no 1: las empresas conectadas por el wizard no tienen fila en la
    # tabla vieja whatsapps, el 1 hardcodeado violaba la FK y el ticket no se
    # creaba. Sin ticket el mensaje de Instagram/Messenger se perdia entero.
    wa_id = wa_row["id"] if wa_row else None

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


# ── Comment-to-DM: comentarios en publicaciones IG/FB ─────────────
async def _handle_comment(db: Session, channel_type: str, entry: dict, change: dict):
    try:
        from app.services.comment_automations import handle_comment_change
        result = await handle_comment_change(db, channel_type, entry, change)
        return {"channel": f"{channel_type}_comment", **(result or {})}
    except Exception as e:
        log.error("[%s comment] error: %s\n%s", channel_type, e, traceback.format_exc())
        db.rollback()
        return {"channel": f"{channel_type}_comment", "error": str(e)[:200]}


# ── Lead Ads: leads de formulario ─────────────────────────────────
def _empresa_de_pagina(db: Session, page_id: str) -> int | None:
    """La página que manda el formulario es la misma que ya está conectada como
    canal de Messenger/Instagram. Antes esto dependía de un ajuste aparte
    (metaLeadAdsPageId) que casi nadie tenía cargado, así que los leads de
    formulario se descartaban por "no company mapped"."""
    fila = db.execute(
        text("SELECT company_id FROM channels WHERE external_id = :p ORDER BY id DESC LIMIT 1"),
        {"p": page_id},
    ).scalar()
    if fila:
        return int(fila)
    # Respaldo: instalaciones viejas que sí tenían el ajuste cargado.
    try:
        for row in db.execute(text("SELECT company_id, settings_json FROM company_runtime_settings")).mappings():
            s = row["settings_json"]
            if isinstance(s, str):
                try:
                    s = json.loads(s)
                except Exception:
                    continue
            if str((s or {}).get("metaLeadAdsPageId", "")).strip() == page_id:
                return int(row["company_id"])
    except Exception as e:
        log.warning("leadgen company lookup failed: %s", e)
    return None


async def _handle_leadgen(db: Session, entry: dict, change: dict, raw_body: bytes, req: Request):
    """Lead de un formulario de Meta. La firma del pedido ya se validó en el
    webhook unificado, así que acá se procesa directo."""
    page_id = str(entry.get("id", ""))
    company_id = _empresa_de_pagina(db, page_id)
    if not company_id:
        log.info("leadgen event from page %s: no company mapped", page_id)
        return {"channel": "leadgen", "ignored": True, "reason": "no_company_for_page"}

    value = change.get("value", {}) or {}
    leadgen_id = str(value.get("leadgen_id") or (value.get("lead") or {}).get("id", "")).strip()
    try:
        from app.services import lead_ads
        res = lead_ads.ingest(db, company_id, page_id, leadgen_id)
        return {"channel": "leadgen", "company_id": company_id, **res}
    except Exception as e:
        log.error("leadgen company=%s: %s", company_id, str(e)[:200])
        db.rollback()
        return {"channel": "leadgen", "error": str(e)[:200]}
