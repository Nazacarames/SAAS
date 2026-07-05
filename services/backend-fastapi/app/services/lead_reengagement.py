"""
Reenganche automático de leads inactivos.

Loop (arranca en main.py): cada 30 min busca, por empresa, leads que
mostraron interés (score o needs), llevan N días sin actividad (default 3)
y no fueron recontactados desde su último mensaje. Les envía una PLANTILLA
de WhatsApp aprobada — fuera de la ventana de 24 h Meta rechaza texto libre,
por eso el template es obligatorio.

Config por empresa en ai_agents.ai_config_json:
  "reengagement": {
    "enabled": true,
    "days": 3,                     // días de inactividad para disparar
    "max_wait_days": 14,           // más viejo que esto no se recontacta
    "template_name": "reenganche_lead",
    "template_lang": "es_AR",
    "template_body": "Hola {{1}}! ..."   // para guardar el texto en la conversación
  }

Marca contacts."lastInactivityFiredAt" al enviar (o al fallar por destino
inválido) para no repetir; si el lead vuelve a escribir, el campo queda
detrás de su última actividad y vuelve a ser elegible más adelante.
"""
import asyncio
import json
import logging

import httpx
from sqlalchemy import text

from app.core.db import SessionLocal

log = logging.getLogger("app.reengagement")

SCAN_INTERVAL_SECONDS = 1800
MAX_PER_COMPANY_PER_RUN = 15
# Errores de Meta que NO deben reintentarse para el mismo lead
_PERMANENT_ERROR_CODES = {131026, 131047, 131051, 100}  # destino inválido / ventana / tipo no soportado
# Template todavía en revisión / pausado → reintentar en la próxima corrida
_RETRY_ERROR_CODES = {132001, 132015, 132016}


def _reengagement_cfg(company_id: int) -> dict:
    db = SessionLocal()
    try:
        row = db.execute(
            text("SELECT ai_config_json FROM ai_agents WHERE company_id = :cid AND is_active = true ORDER BY id DESC LIMIT 1"),
            {"cid": company_id},
        ).mappings().first()
        raw = {}
        if row and row["ai_config_json"]:
            try:
                raw = json.loads(row["ai_config_json"]) or {}
            except Exception:
                raw = {}
        return raw.get("reengagement") or {}
    finally:
        db.close()


def _candidates(db, company_id: int, days: int, max_wait_days: int) -> list:
    return db.execute(
        text('''
            SELECT c.id, c.name, c.number, c.needs, c.lead_score, m.last_at
            FROM contacts c
            JOIN LATERAL (
                SELECT MAX(msg."createdAt") AS last_at FROM messages msg WHERE msg."contactId" = c.id
            ) m ON TRUE
            WHERE c."companyId" = :cid
              AND COALESCE(c."isGroup", false) = false
              AND COALESCE(c.number, '') <> ''
              AND COALESCE(c."leadStatus", 'new') NOT IN ('customer', 'lost')
              AND (COALESCE(c.lead_score, 0) >= 20 OR COALESCE(c.needs, '') <> '')
              AND m.last_at IS NOT NULL
              AND m.last_at <= NOW() - (:days || ' days')::interval
              AND m.last_at >= NOW() - (:maxdays || ' days')::interval
              AND (c."lastInactivityFiredAt" IS NULL OR c."lastInactivityFiredAt" < m.last_at)
            ORDER BY c.lead_score DESC NULLS LAST
            LIMIT :lim
        '''),
        {"cid": company_id, "days": days, "maxdays": max_wait_days, "lim": MAX_PER_COMPANY_PER_RUN},
    ).mappings().all()


def _send_template(wa: dict, to_number: str, template: str, lang: str, first_name: str) -> tuple[bool, int, str]:
    """Returns (ok, meta_error_code, error_message)."""
    payload = {
        "messaging_product": "whatsapp",
        "to": to_number,
        "type": "template",
        "template": {
            "name": template,
            "language": {"code": lang},
            "components": [
                {"type": "body", "parameters": [{"type": "text", "text": first_name or "!"}]}
            ],
        },
    }
    try:
        resp = httpx.post(
            f"https://graph.facebook.com/v21.0/{wa['phone_number_id']}/messages",
            json=payload,
            headers={"Authorization": f"Bearer {wa['access_token']}"},
            timeout=20,
        )
        if resp.status_code == 200:
            return True, 0, ""
        err = (resp.json() or {}).get("error", {}) if "json" in resp.headers.get("content-type", "") else {}
        return False, int(err.get("code") or resp.status_code), str(err.get("message") or resp.text[:200])
    except Exception as e:
        return False, -1, str(e)[:200]


def _mark_fired(db, contact_id: int) -> None:
    db.execute(
        text('UPDATE contacts SET "lastInactivityFiredAt" = NOW(), "updatedAt" = NOW() WHERE id = :id'),
        {"id": contact_id},
    )
    db.commit()


_SCAN_LOCK_KEY = 815001  # pg advisory lock: 2 uvicorn workers, 1 solo scan


def _run_scan() -> None:
    db = SessionLocal()
    try:
        # Ambos workers corren el loop; solo uno ejecuta el scan por vez.
        if not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _SCAN_LOCK_KEY}).scalar():
            return
        companies = db.execute(
            text("SELECT DISTINCT company_id FROM channels WHERE channel_type = 'whatsapp' AND status = 'active'")
        ).mappings().all()

        from app.services.billing_service import check_subscription_active, increment_usage
        from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, save_message

        for row in companies:
            cid = int(row["company_id"])
            cfg = _reengagement_cfg(cid)
            if not cfg.get("enabled") or not cfg.get("template_name"):
                continue
            ok, _ = check_subscription_active(db, cid)
            if not ok:
                continue
            wa = get_whatsapp_config(db, cid)
            if not wa:
                continue

            days = max(1, int(cfg.get("days", 3)))
            max_wait = max(days + 1, int(cfg.get("max_wait_days", 14)))
            template = cfg["template_name"]
            lang = cfg.get("template_lang", "es_AR")
            body_tpl = cfg.get("template_body", "")

            for lead in _candidates(db, cid, days, max_wait):
                first_name = (str(lead["name"] or "").strip().split(" ") or [""])[0]
                sent, code, err = _send_template(wa, str(lead["number"]), template, lang, first_name)
                if sent:
                    _mark_fired(db, int(lead["id"]))
                    try:
                        rendered = body_tpl.replace("{{1}}", first_name) if body_tpl else f"[plantilla {template}] Reenganche por inactividad"
                        save_message(db, int(lead["id"]), rendered, True, cid)
                        increment_usage(db, cid, "messages_sent")
                        increment_usage(db, cid, "reengagements")
                    except Exception:
                        pass
                    log.info("reengagement sent company=%s contact=%s", cid, lead["id"])
                elif code in _RETRY_ERROR_CODES:
                    # plantilla pending/pausada: no marcar, reintenta próxima corrida
                    log.warning("reengagement retry-later company=%s code=%s %s", cid, code, err)
                    break  # si la plantilla no está lista, no insistir con más leads
                else:
                    # error permanente para este destino: marcar para no loopear
                    _mark_fired(db, int(lead["id"]))
                    try:
                        db.execute(
                            text("""INSERT INTO integration_errors (company_id, source, severity, error_code, message, suggestion, payload_json, created_at)
                                    VALUES (:cid, 'whatsapp', 'warning', :code, :msg, 'Revisar plantilla de reenganche / número del contacto', :pj, NOW())"""),
                            {"cid": cid, "code": str(code), "msg": f"Reenganche falló: {err}"[:250],
                             "pj": json.dumps({"contact_id": int(lead["id"]), "template": template})},
                        )
                        db.commit()
                    except Exception:
                        db.rollback()
    finally:
        try:
            db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _SCAN_LOCK_KEY})
            db.commit()
        except Exception:
            pass
        db.close()


async def reengagement_loop() -> None:
    log.info("lead reengagement loop started (every %ss)", SCAN_INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(_run_scan)
        except Exception as e:
            log.error("reengagement scan error: %s", e)
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)
