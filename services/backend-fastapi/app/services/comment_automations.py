"""
Comment-to-DM: cuando alguien comenta una publicación de Instagram o Facebook
con cierta palabra clave, el agente lo contacta por mensaje directo en esa red
(private reply de Meta: POST /{ig_id|page_id}/messages con recipient.comment_id,
válido hasta 7 días después del comentario, 1 private reply por comentario).

Reglas por empresa en la tabla comment_automations:
  - channel_type: 'instagram' | 'messenger' (Facebook Page)
  - keywords: lista separada por comas; vacío = cualquier comentario
  - post_id: opcional, limita la regla a una publicación puntual
  - agent_generated: el agente redacta el DM personalizado con el comentario
    y la persona del negocio; si es false se envía message_text tal cual
    (soporta {nombre} y {comentario})

Idempotencia: comment_dm_log.comment_id UNIQUE — un comentario dispara a lo
sumo un DM aunque Meta reenvíe el webhook o matcheen varias reglas.
"""
from __future__ import annotations

import asyncio
import json
import logging
import unicodedata

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.comment_automations")

GRAPH_VERSION = "v21.0"


def ensure_tables(db: Session) -> None:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS comment_automations (
            id BIGSERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            channel_type VARCHAR(20) NOT NULL,
            name VARCHAR(120) NOT NULL DEFAULT '',
            keywords TEXT NOT NULL DEFAULT '',
            post_id VARCHAR(120) NOT NULL DEFAULT '',
            agent_generated BOOLEAN NOT NULL DEFAULT true,
            message_text TEXT NOT NULL DEFAULT '',
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"""))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS comment_dm_log (
            id BIGSERIAL PRIMARY KEY,
            automation_id BIGINT,
            company_id INTEGER NOT NULL,
            channel_type VARCHAR(20) NOT NULL,
            comment_id VARCHAR(160) NOT NULL UNIQUE,
            commenter_id VARCHAR(120) NOT NULL DEFAULT '',
            commenter_name VARCHAR(200) NOT NULL DEFAULT '',
            comment_text TEXT NOT NULL DEFAULT '',
            dm_text TEXT NOT NULL DEFAULT '',
            ok BOOLEAN,
            error TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"""))
    db.commit()


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def _matches(automation: dict, comment_text: str, post_id: str) -> bool:
    rule_post = str(automation.get("post_id") or "").strip()
    if rule_post and rule_post not in (post_id or ""):
        return False
    kw_raw = str(automation.get("keywords") or "").strip()
    if not kw_raw:
        return True
    body = _norm(comment_text)
    return any(_norm(k.strip()) in body for k in kw_raw.split(",") if k.strip())


def _extract_comment(channel_type: str, entry: dict, change: dict) -> dict | None:
    """Normaliza el payload de comments (IG) / feed (FB Page) a un dict común."""
    v = change.get("value") or {}
    account_id = str(entry.get("id", ""))

    if channel_type == "instagram":
        comment_id = str(v.get("id") or "")
        frm = v.get("from") or {}
        media = v.get("media") or {}
        post_id = str(media.get("id") or "")
        name = str(frm.get("username") or "")
    else:  # messenger (Facebook Page feed)
        if v.get("item") != "comment" or v.get("verb") != "add":
            return None
        comment_id = str(v.get("comment_id") or "")
        frm = v.get("from") or {}
        post_id = str(v.get("post_id") or "")
        name = str(frm.get("name") or "")

    commenter_id = str(frm.get("id") or "")
    if not comment_id or not commenter_id:
        return None
    if commenter_id == account_id:
        return None  # comentario de la propia cuenta/página
    return {
        "comment_id": comment_id,
        "commenter_id": commenter_id,
        "commenter_name": name,
        "text": str(v.get("text") or v.get("message") or ""),
        "post_id": post_id,
    }


def _first_name(full: str) -> str:
    return (full or "").strip().split(" ")[0]


def _agent_dm_text(db: Session, company_id: int, comment: dict, automation: dict) -> str:
    """El agente redacta el DM a partir del comentario. Fallback determinístico."""
    name = _first_name(comment["commenter_name"])
    greeting = f"Hola {name}! " if name else "Hola! "
    fallback = (greeting + "Vimos tu comentario en nuestra publicación y queremos ayudarte. "
                "Contanos qué estás buscando y te pasamos toda la info por acá.")
    try:
        from app.core.config import settings
        if not settings.openai_api_key:
            return fallback
        from app.services.knowledge_base import get_ai_agent_config
        persona = (get_ai_agent_config(company_id).get("persona") or "")[:400]
        extra = str(automation.get("message_text") or "").strip()[:300]

        from openai import OpenAI
        client = OpenAI(api_key=settings.openai_api_key, timeout=25.0, max_retries=1)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": (
                    "Sos el asistente comercial de un negocio argentino.\n"
                    f"Tu estilo: {persona}\n\n"
                    f"{comment['commenter_name'] or 'Una persona'} comentó en una publicación de la marca: "
                    f"\"{comment['text'][:300]}\"\n"
                    + (f"Instrucciones del negocio para este caso: {extra}\n" if extra else "")
                    + "\nEscribí el PRIMER mensaje directo para esa persona (máximo 400 caracteres, sin emojis "
                    "excesivos): saludala por su nombre si lo tenés, referí a su comentario, respondé o "
                    "encaminá su consulta y cerrá con una pregunta corta para que responda. "
                    "Español argentino, cordial y directo. Devolvé SOLO el mensaje."
                ),
            }],
            max_tokens=180,
            temperature=0.7,
        )
        txt = (resp.choices[0].message.content or "").strip().strip('"')
        return txt[:900] if len(txt) >= 20 else fallback
    except Exception as e:
        log.warning("agent dm generation failed company=%s: %s", company_id, str(e)[:120])
        return fallback


async def _send_private_reply(config: dict, comment_id: str, message: str) -> tuple[bool, str]:
    account_id = config.get("phoneId") or config.get("external_id", "")
    token = config.get("token", "")
    if not account_id or not token:
        return False, "channel_not_configured"
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{account_id}/messages"
    payload = {"recipient": {"comment_id": comment_id}, "message": {"text": message}}
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url, json=payload,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                timeout=30,
            )
        if resp.status_code in (200, 201):
            return True, ""
        return False, resp.text[:300]
    except Exception as e:
        return False, str(e)[:300]


async def handle_comment_change(db: Session, channel_type: str, entry: dict, change: dict) -> dict:
    """Punto de entrada desde el webhook de Meta. channel_type: instagram|messenger."""
    from app.services.channels.registry import resolve_channel, get_send_config
    from app.services.billing_service import check_subscription_active, increment_usage

    comment = _extract_comment(channel_type, entry, change)
    if not comment:
        return {"ignored": True, "reason": "not_a_user_comment"}

    channel = resolve_channel(db, channel_type, str(entry.get("id", "")))
    if not channel or channel.get("status") != "active":
        return {"ignored": True, "reason": "no_active_channel"}
    company_id = int(channel["company_id"])

    ensure_tables(db)
    automations = db.execute(
        text("""SELECT * FROM comment_automations
                WHERE company_id = :cid AND channel_type = :ct AND enabled = true
                ORDER BY id ASC"""),
        {"cid": company_id, "ct": channel_type},
    ).mappings().all()
    matched = next((dict(a) for a in automations if _matches(dict(a), comment["text"], comment["post_id"])), None)
    if not matched:
        return {"ignored": True, "reason": "no_matching_rule"}

    ok_sub, _ = check_subscription_active(db, company_id)
    if not ok_sub:
        return {"ignored": True, "reason": "subscription_inactive"}

    # Idempotencia: si el comment_id ya está en el log, no volvemos a enviar
    claimed = db.execute(
        text("""INSERT INTO comment_dm_log
                    (automation_id, company_id, channel_type, comment_id, commenter_id, commenter_name, comment_text)
                VALUES (:aid, :cid, :ct, :comid, :uid, :uname, :ctext)
                ON CONFLICT (comment_id) DO NOTHING RETURNING id"""),
        {"aid": matched["id"], "cid": company_id, "ct": channel_type,
         "comid": comment["comment_id"], "uid": comment["commenter_id"],
         "uname": comment["commenter_name"][:200], "ctext": comment["text"][:2000]},
    ).mappings().first()
    db.commit()
    if not claimed:
        return {"ignored": True, "reason": "already_handled"}
    log_id = int(claimed["id"])

    if matched.get("agent_generated", True):
        dm_text = await asyncio.to_thread(_agent_dm_text, db, company_id, comment, matched)
    else:
        dm_text = (str(matched.get("message_text") or "").strip()
                   .replace("{nombre}", _first_name(comment["commenter_name"]) or "!")
                   .replace("{comentario}", comment["text"][:200]))
        if not dm_text:
            dm_text = "Hola! Vimos tu comentario en nuestra publicación. Contanos qué estás buscando y te ayudamos por acá."

    sent, err = await _send_private_reply(get_send_config(channel), comment["comment_id"], dm_text)
    db.execute(
        text("UPDATE comment_dm_log SET dm_text = :dm, ok = :ok, error = :err WHERE id = :id"),
        {"dm": dm_text, "ok": sent, "err": err, "id": log_id},
    )
    db.commit()

    if sent:
        try:
            increment_usage(db, company_id, "messages_sent")
        except Exception:
            db.rollback()
        log.info("comment DM sent company=%s channel=%s comment=%s", company_id, channel_type, comment["comment_id"])
    else:
        log.warning("comment DM failed company=%s comment=%s err=%s", company_id, comment["comment_id"], err[:150])

    return {"ok": sent, "automation_id": matched["id"], "error": err or None}


async def ensure_page_feed_subscription(db: Session, channel: dict) -> tuple[bool, str]:
    """Al activar una regla de Facebook, agrega el campo 'feed' a subscribed_apps
    de la página (sin pisar los campos ya suscriptos). Para Instagram los
    comentarios llegan por la suscripción a nivel app (campo 'comments')."""
    from app.services.channels.registry import get_send_config
    config = get_send_config(channel)
    page_id, token = config.get("external_id", ""), config.get("token", "")
    if not page_id or not token:
        return False, "channel_not_configured"
    base = f"https://graph.facebook.com/{GRAPH_VERSION}/{page_id}/subscribed_apps"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(base, params={"access_token": token}, timeout=20)
            fields: set[str] = set()
            if resp.status_code == 200:
                for app_entry in (resp.json().get("data") or []):
                    fields.update(app_entry.get("subscribed_fields") or [])
            if "feed" in fields:
                return True, ""
            fields.update({"feed", "messages", "messaging_postbacks"})
            resp = await client.post(base, params={
                "subscribed_fields": ",".join(sorted(fields)),
                "access_token": token,
            }, timeout=20)
        if resp.status_code == 200 and (resp.json() or {}).get("success"):
            return True, ""
        return False, resp.text[:200]
    except Exception as e:
        return False, str(e)[:200]
