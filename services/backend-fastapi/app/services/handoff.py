"""
Derivación a un asesor humano.

El agente prometía "te paso con un asesor" y no pasaba nada: el lead quedaba
sin asignar, nadie se enteraba y el cliente esperaba una respuesta que no
llegaba. Acá la derivación es real: asigna (round-robin), avisa al asesor por
WhatsApp, deja nota en el hilo y pausa al agente.

El asesor se elige entre los usuarios de la empresa marcados como asesores en
la config del agente (ai_config_json.advisor_user_ids); si no hay lista, entre
todos los usuarios activos de la empresa.
"""
import json
import logging

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.handoff")

GRAPH_VERSION = "v21.0"


def _advisor_pool(db: Session, company_id: int) -> list[dict]:
    cfg = {}
    try:
        raw = db.execute(
            text("SELECT ai_config_json FROM ai_agents WHERE company_id = :c AND is_active = true ORDER BY id DESC LIMIT 1"),
            {"c": company_id},
        ).scalar()
        cfg = json.loads(raw) if raw else {}
    except Exception:
        pass

    # Teléfonos de los asesores: users no tiene columna de teléfono, así que se
    # reusa lo que ya está cargado en el Menú Bot (assign_users + rr_notify_numbers)
    # y se permite override explícito en ai_config_json.advisors.
    phones: dict[int, str] = {}
    for a in (cfg.get("advisors") or []):
        try:
            phones[int(a.get("user_id"))] = "".join(c for c in str(a.get("number") or "") if c.isdigit())
        except Exception:
            continue
    try:
        raw_flow = db.execute(text("SELECT flow_json FROM bot_flows WHERE company_id = :c"), {"c": company_id}).scalar()
        flow = json.loads(raw_flow) if raw_flow else {}
        for opt in (flow.get("options") or []):
            users = [int(u) for u in (opt.get("assign_users") or []) if u]
            nums = [str(n or "") for n in (opt.get("rr_notify_numbers") or [])]
            for i, uid in enumerate(users):
                if uid not in phones and i < len(nums) and nums[i]:
                    phones[uid] = "".join(c for c in nums[i] if c.isdigit())
                elif uid not in phones and opt.get("notify_number"):
                    phones[uid] = "".join(c for c in str(opt["notify_number"]) if c.isdigit())
    except Exception:
        pass

    ids = [int(u) for u in (cfg.get("advisor_user_ids") or []) if str(u).strip()]
    if not ids:
        ids = list(phones.keys())  # los que el cliente ya configuró como asesores
    if ids:
        rows = db.execute(
            text('SELECT id, name FROM users WHERE "companyId" = :c AND id = ANY(:ids) ORDER BY id'),
            {"c": company_id, "ids": ids},
        ).mappings().all()
    else:
        # sin asesores configurados: los usuarios operativos (no el admin dueño)
        rows = db.execute(
            text("SELECT id, name FROM users WHERE \"companyId\" = :c AND profile = 'user' ORDER BY id"),
            {"c": company_id},
        ).mappings().all()
        if not rows:
            rows = db.execute(
                text('SELECT id, name FROM users WHERE "companyId" = :c ORDER BY id'),
                {"c": company_id},
            ).mappings().all()
    return [{**dict(r), "number": phones.get(int(r["id"]), "")} for r in rows]


def _pick_round_robin(db: Session, company_id: int, n: int, key: str = "handoff") -> int:
    """Reparte parejo entre los asesores (mismo contador que usa el Menú Bot)."""
    if n <= 1:
        return 0
    try:
        idx = db.execute(text("""
            INSERT INTO rr_counters (company_id, counter_key, idx) VALUES (:c, :k, 1)
            ON CONFLICT (company_id, counter_key) DO UPDATE SET idx = rr_counters.idx + 1
            RETURNING idx"""), {"c": company_id, "k": key}).scalar()
        db.commit()
        return (int(idx) - 1) % n
    except Exception:
        db.rollback()
        return 0


def ensure_assigned(db: Session, company_id: int, contact_id: int) -> dict:
    """Todo lead entra con dueño: si nadie lo tiene, se reparte por round-robin.

    Aplica a cualquier canal (WhatsApp, Instagram, Messenger) apenas entra el
    primer mensaje, así cada asesor ve en su usuario del CRM los que le tocan
    sin depender de que el bot o la IA lo deriven."""
    try:
        cur = db.execute(
            text('SELECT "assignedUserId" FROM contacts WHERE id = :i AND "companyId" = :c'),
            {"i": contact_id, "c": company_id},
        ).scalar()
        if cur:
            return {"ok": True, "already": True}

        pool = _advisor_pool(db, company_id)
        if not pool:
            return {"ok": False, "reason": "sin asesores configurados"}

        advisor = pool[_pick_round_robin(db, company_id, len(pool), key="autoassign")]
        db.execute(
            text('UPDATE contacts SET "assignedUserId" = :u, "updatedAt" = NOW() WHERE id = :i'),
            {"u": advisor["id"], "i": contact_id},
        )
        db.commit()
        log.info("autoasignado company=%s contact=%s -> %s", company_id, contact_id, advisor.get("name"))
        return {"ok": True, "asesor": advisor.get("name"), "user_id": advisor["id"]}
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        return {"ok": False, "error": str(e)[:120]}


def _notify_advisor(db: Session, company_id: int, advisor: dict, contact: dict,
                    motivo: str, resumen: str) -> bool:
    """Aviso por WhatsApp al asesor. Si está fuera de la ventana de 24 h de
    Meta, cae a la plantilla nuevo_cliente (la misma del Menú Bot)."""
    to = "".join(c for c in str(advisor.get("number") or "") if c.isdigit())
    if not to:
        return False
    try:
        from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config
        wa = get_whatsapp_config(db, company_id)
        if not wa:
            return False

        lead_name = str(contact.get("name") or "").strip() or "Nuevo cliente"
        lead_num = str(contact.get("number") or "")
        body = f"🔔 Nuevo cliente para atender: {lead_name} (+{lead_num})"
        if motivo:
            body += f"\nMotivo: {motivo}"
        if resumen:
            body += f"\n{resumen}"
        body += "\nEntrá al CRM para seguir la conversación."

        url = f"https://graph.facebook.com/{GRAPH_VERSION}/{wa['phoneId']}/messages"
        headers = {"Authorization": f"Bearer {wa['token']}"}
        r = httpx.post(url, headers=headers, timeout=20, json={
            "messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": body}})
        if r.status_code == 200:
            return True
        # fuera de la ventana de 24 h: plantilla
        r = httpx.post(url, headers=headers, timeout=20, json={
            "messaging_product": "whatsapp", "to": to, "type": "template",
            "template": {"name": "nuevo_cliente", "language": {"code": "es_AR"},
                         "components": [{"type": "body", "parameters": [
                             {"type": "text", "text": lead_name},
                             {"type": "text", "text": lead_num or "-"}]}]}})
        return r.status_code == 200
    except Exception as e:
        log.warning("notify advisor company=%s: %s", company_id, str(e)[:120])
        return False


def derive_to_advisor(db: Session, company_id: int, contact_id: int,
                      motivo: str = "", resumen: str = "") -> dict:
    contact = db.execute(
        text('SELECT id, name, number FROM contacts WHERE id = :i AND "companyId" = :c'),
        {"i": contact_id, "c": company_id},
    ).mappings().first()
    if not contact:
        return {"ok": False, "error": "contacto no encontrado"}

    pool = _advisor_pool(db, company_id)
    advisor = pool[_pick_round_robin(db, company_id, len(pool))] if pool else None

    if advisor:
        db.execute(
            text('UPDATE contacts SET "assignedUserId" = :u, "updatedAt" = NOW() WHERE id = :i'),
            {"u": advisor["id"], "i": contact_id},
        )
    # el agente se calla: a partir de acá contesta la persona
    db.execute(text('UPDATE contacts SET ai_paused = true, "updatedAt" = NOW() WHERE id = :i'),
               {"i": contact_id})
    db.commit()

    notified = _notify_advisor(db, company_id, advisor, dict(contact), motivo, resumen) if advisor else False

    try:
        db.execute(
            text("INSERT INTO flow_events (company_id, event_key, contact_id) VALUES (:c, 'handoff', :i)"),
            {"c": company_id, "i": contact_id},
        )
        db.commit()
    except Exception:
        db.rollback()

    log.info("handoff company=%s contact=%s asesor=%s avisado=%s",
             company_id, contact_id, (advisor or {}).get("name"), notified)
    return {
        "ok": True,
        "asesor": (advisor or {}).get("name") or "el equipo",
        "asignado": bool(advisor),
        "notificado": notified,
        "mensaje": f"Derivado a {(advisor or {}).get('name') or 'el equipo'}. "
                   "Decile al cliente que un asesor lo contacta en breve, sin prometer horarios.",
    }
