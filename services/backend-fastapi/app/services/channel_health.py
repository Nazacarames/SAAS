"""
Monitoreo de salud de canales.

Cada 6 h revisa todos los canales activos contra Meta: token vivo y webhooks
suscriptos a NUESTRA app (o appSecret propio configurado). Si un canal dejó de
poder recibir, lo registra en integration_errors (dedup 24 h) para que aparezca
en el panel de monitoreo — antes un canal roto se descubría recién cuando un
cliente se quejaba de que nadie respondía.
"""
import asyncio
import json
import logging
import os

import httpx
from sqlalchemy import text

from app.core.db import SessionLocal
from app.services.crypto import decrypt

log = logging.getLogger("app.channel_health")

GRAPH = "https://graph.facebook.com/v21.0"
SCAN_INTERVAL_SECONDS = 6 * 3600
_SCAN_LOCK_KEY = 815002  # pg advisory lock (2 workers, 1 scan)


def _check_channel(ch: dict, our_app: str) -> str:
    """Devuelve '' si el canal está sano, o la descripción del problema."""
    token = decrypt(ch["mc_token"]) if ch["mc_token"] else ""
    if not token:
        return "El canal no tiene token guardado"
    cfg = json.loads(ch["config_json"]) if isinstance(ch["config_json"], str) else (ch["config_json"] or {})
    try:
        with httpx.Client(timeout=20) as c:
            dbg = c.get(f"{GRAPH}/debug_token", params={"input_token": token, "access_token": token})
            data = dbg.json().get("data", {}) if dbg.status_code == 200 else {}
            if not data.get("is_valid"):
                return "El token venció o fue revocado: reconectar el canal"
            foreign = bool(our_app and str(data.get("app_id") or "") != our_app)
            if foreign and not cfg.get("appSecret"):
                return "Token de otra app de Meta sin App Secret cargado: los webhooks se rechazan"

            if ch["channel_type"] == "whatsapp":
                waba = cfg.get("wabaId", "")
                if not waba:
                    return ""  # sin waba cacheado no se puede verificar barato; lo cubre el diagnose manual
                r = c.get(f"{GRAPH}/{waba}/subscribed_apps", params={"access_token": token})
                if r.status_code != 200:
                    return f"No se pudo verificar la suscripción del WABA ({r.status_code})"
                apps = [str((a.get("whatsapp_business_api_data") or {}).get("id") or "")
                        for a in (r.json().get("data") or [])]
                expected = str(data.get("app_id") or "") if foreign else our_app
                if expected not in apps:
                    return "El WABA no está suscripto a la app: no llegan los mensajes (usar Reparar)"
            else:
                page_id = ch["external_id"] if ch["channel_type"] == "messenger" else ""
                me = c.get(f"{GRAPH}/me", params={"access_token": token, "fields": "id"})
                if me.status_code == 200 and me.json().get("id"):
                    page_id = me.json()["id"]
                if not page_id:
                    return "No se pudo identificar la página del canal"
                r = c.get(f"{GRAPH}/{page_id}/subscribed_apps", params={"access_token": token})
                subs = (r.json().get("data") or []) if r.status_code == 200 else []
                fields = {f for a in subs for f in (a.get("subscribed_fields") or [])}
                if "messages" not in fields:
                    return "La página no está suscripta a mensajes: no llegan los DMs (usar Reparar)"
    except Exception as e:
        return f"No se pudo verificar contra Meta: {str(e)[:80]}"
    return ""


def _run_scan() -> None:
    db = SessionLocal()
    try:
        if not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _SCAN_LOCK_KEY}).scalar():
            return
        our_app = os.getenv("META_APP_ID", "").strip()
        rows = db.execute(text("""
            SELECT c.id, c.company_id, c.channel_type, c.name, c.external_id, c.config_json,
                   mc.access_token AS mc_token
            FROM channels c LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
            WHERE c.status = 'active'""")).mappings().all()
        for ch in rows:
            problem = _check_channel(dict(ch), our_app)
            if not problem:
                continue
            # dedup: mismo canal + mismo problema en las últimas 24 h
            dup = db.execute(text("""
                SELECT 1 FROM integration_errors
                WHERE company_id = :cid AND source = 'channel_health'
                  AND payload_json::jsonb ->> 'channel_id' = :chid
                  AND message = :msg AND created_at > NOW() - INTERVAL '24 hours'
                LIMIT 1"""), {"cid": ch["company_id"], "chid": str(ch["id"]), "msg": problem[:250]}).scalar()
            if dup:
                continue
            try:
                db.execute(text("""
                    INSERT INTO integration_errors (company_id, source, severity, error_code, message, suggestion, payload_json, created_at)
                    VALUES (:cid, 'channel_health', 'error', 'channel_broken', :msg,
                            'Abrí Canales y usá Verificar canales / Reparar', :pj, NOW())"""),
                    {"cid": ch["company_id"], "msg": problem[:250],
                     "pj": json.dumps({"channel_id": ch["id"], "channel_type": ch["channel_type"],
                                       "name": ch["name"], "external_id": ch["external_id"]})})
                db.commit()
                log.warning("channel_health: canal %s (%s) roto: %s", ch["id"], ch["name"], problem)
            except Exception:
                db.rollback()
    finally:
        try:
            db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _SCAN_LOCK_KEY})
            db.commit()
        except Exception:
            pass
        db.close()


async def channel_health_loop() -> None:
    log.info("channel health loop started (every %ss)", SCAN_INTERVAL_SECONDS)
    await asyncio.sleep(120)  # no competir con el arranque
    while True:
        try:
            await asyncio.to_thread(_run_scan)
        except Exception as e:
            log.error("channel health scan error: %s", e)
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)
