"""Appointment reminder loop.

Background task started at app startup. Every ~2 minutes it scans upcoming
scheduled appointments and sends WhatsApp reminders to the contact:

  - 24h reminder: appointments starting in 23h..25h, not yet reminded
  - 1h  reminder: appointments starting in 30m..70m, not yet reminded

The send windows are wider than the poll period so a short downtime does not
silently skip reminders. Each reminder is recorded both on the appointment row
(reminder_*_sent_at) and as an outbound message in the conversation, so the
agent and the human team see exactly what the client received.
"""
import asyncio
import json
import logging
import traceback
from datetime import datetime

from sqlalchemy import text

from app.core.db import SessionLocal

POLL_SECONDS = 120

_log = logging.getLogger("app.access")

DEFAULT_24H_TEMPLATE = (
    "¡Hola {name}! Te recordamos tu cita de mañana: {date} a las {time} hs."
    "{notes_line} Si necesitás reprogramar, respondé este mensaje. ¡Te esperamos!"
)
DEFAULT_1H_TEMPLATE = (
    "¡Hola {name}! Te recordamos que tu cita es hoy a las {time} hs, en aproximadamente una hora."
    "{notes_line} ¡Nos vemos pronto!"
)


def _format_reminder(template: str, *, name: str, starts_at, notes: str) -> str:
    try:
        from zoneinfo import ZoneInfo
        local = starts_at.astimezone(ZoneInfo("America/Argentina/Buenos_Aires"))
    except Exception:
        local = starts_at
    date_str = local.strftime("%d/%m/%Y")
    time_str = local.strftime("%H:%M")
    notes_line = f" Detalle: {notes.strip()}." if (notes or "").strip() else ""
    first_name = (name or "").strip().split(" ")[0] or "cliente"
    return template.format(name=first_name, date=date_str, time=time_str, notes_line=notes_line)


def _get_reminder_templates(db, company_id: int) -> tuple[str, str]:
    """Per-agent override via ai_config_json: reminder_24h_msg / reminder_1h_msg."""
    t24, t1 = DEFAULT_24H_TEMPLATE, DEFAULT_1H_TEMPLATE
    try:
        row = db.execute(
            text("SELECT ai_config_json FROM ai_agents WHERE company_id = :cid AND is_active = true ORDER BY id DESC LIMIT 1"),
            {"cid": company_id},
        ).mappings().first()
        if row and row.get("ai_config_json"):
            cfg = json.loads(row["ai_config_json"])
            t24 = (cfg.get("reminder_24h_msg") or "").strip() or t24
            t1 = (cfg.get("reminder_1h_msg") or "").strip() or t1
    except Exception:
        pass
    return t24, t1


async def _send_reminder(db, appt: dict, kind: str, template: str) -> bool:
    from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, send_whatsapp_message, save_message

    company_id = int(appt["company_id"])
    wa_config = get_whatsapp_config(db, company_id)
    if not wa_config:
        _log.info(f"[reminders] company {company_id}: no WhatsApp config, skipping appt {appt['id']}")
        return False

    number = str(appt.get("contact_number") or "").strip()
    if not number:
        _log.info(f"[reminders] appt {appt['id']}: contact has no number, skipping")
        return False

    body = _format_reminder(
        template,
        name=str(appt.get("contact_name") or ""),
        starts_at=appt["starts_at"],
        notes=str(appt.get("notes") or ""),
    )

    # Atomic claim BEFORE sending: with multiple uvicorn workers running the
    # loop, only the worker that flips the NULL column gets to send. If the
    # send then fails, the claim is released so the next cycle retries.
    col = "reminder_24h_sent_at" if kind == "24h" else "reminder_1h_sent_at"
    claimed = db.execute(
        text(f"UPDATE appointments SET {col} = NOW(), updated_at = NOW() WHERE id = :id AND {col} IS NULL RETURNING id"),
        {"id": appt["id"]},
    ).mappings().first()
    db.commit()
    if not claimed:
        return False  # another worker already claimed this reminder

    result = await send_whatsapp_message(number, body, wa_config)
    if not result.get("ok"):
        _log.info(f"[reminders] appt {appt['id']} {kind}: send failed: {str(result)[:200]}")
        db.execute(
            text(f"UPDATE appointments SET {col} = NULL WHERE id = :id"),
            {"id": appt["id"]},
        )
        db.commit()
        return False

    # Record in conversation so the team sees the reminder in the chat history
    try:
        save_message(db, int(appt["contact_id"]), body, True, company_id)
    except Exception as e:
        _log.info(f"[reminders] appt {appt['id']}: could not save message row: {e}")

    _log.info(f"[reminders] appt {appt['id']} ({kind}) sent to {number}")
    return True


async def _run_once() -> None:
    db = SessionLocal()
    try:
        base_query = (
            "SELECT a.id, a.company_id, a.contact_id, a.starts_at, a.notes, "
            "c.name AS contact_name, c.number AS contact_number "
            "FROM appointments a JOIN contacts c ON c.id = a.contact_id "
            "WHERE a.status = 'scheduled' AND {window} AND a.{col} IS NULL "
            "ORDER BY a.starts_at ASC LIMIT 50"
        )

        due_24h = db.execute(text(base_query.format(
            window="a.starts_at BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'",
            col="reminder_24h_sent_at",
        ))).mappings().all()

        due_1h = db.execute(text(base_query.format(
            window="a.starts_at BETWEEN NOW() + INTERVAL '30 minutes' AND NOW() + INTERVAL '70 minutes'",
            col="reminder_1h_sent_at",
        ))).mappings().all()

        templates_cache: dict[int, tuple[str, str]] = {}
        for appt in due_24h:
            cid = int(appt["company_id"])
            if cid not in templates_cache:
                templates_cache[cid] = _get_reminder_templates(db, cid)
            await _send_reminder(db, dict(appt), "24h", templates_cache[cid][0])

        for appt in due_1h:
            cid = int(appt["company_id"])
            if cid not in templates_cache:
                templates_cache[cid] = _get_reminder_templates(db, cid)
            await _send_reminder(db, dict(appt), "1h", templates_cache[cid][1])
    finally:
        db.close()


async def reminder_loop() -> None:
    _log.info("[reminders] appointment reminder loop started")
    while True:
        try:
            await _run_once()
        except Exception:
            _log.info(f"[reminders] loop iteration failed:\n{traceback.format_exc()}")
        await asyncio.sleep(POLL_SECONDS)
