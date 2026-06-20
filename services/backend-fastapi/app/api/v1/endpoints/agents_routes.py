"""Agent management, leads, contacts, notes, dedupe, funnel, appointments."""
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin, get_db
from app.api.v1.endpoints._ai_shared import (
    AgentCreate, AgentUpdate, NoteCreate, NoteUpdate,
    LeadRecalculateScoreRequest, LeadStatusRequest,
    _ensure_crm_feature_tables, _parse_mentions, _parse_tags,
    _score_lead, _infer_lead_status_by_signals, _score_from_text,
    _normalize_phone, _normalize_email, _get_runtime_settings,
)

router = APIRouter()


def _validate_json_field(value: Optional[str], field_name: str, expect: type) -> None:
    """Reject malformed JSON config before it reaches the DB (it would
    otherwise be silently discarded at read time by get_ai_agent_config)."""
    if value is None or value == "":
        return
    try:
        parsed = json.loads(value)
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} no es JSON válido")
    if not isinstance(parsed, expect):
        kind = "objeto" if expect is dict else "lista"
        raise HTTPException(status_code=400, detail=f"{field_name} debe ser un {kind} JSON")


def _deactivate_other_agents(db: Session, company_id: int, keep_id: Optional[int] = None) -> None:
    """Enforce a single active agent per company so the orchestrator's
    is_active lookup is deterministic."""
    params = {"companyId": company_id}
    sql = "UPDATE ai_agents SET is_active = false, updated_at = NOW() WHERE company_id = :companyId AND is_active = true"
    if keep_id is not None:
        sql += " AND id != :keepId"
        params["keepId"] = keep_id
    db.execute(text(sql), params)


# ── Agents ────────────────────────────────────────────────────────────

@router.get("/agents")
def list_agents(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    rows = db.execute(
        text("SELECT * FROM ai_agents WHERE company_id = :companyId ORDER BY id DESC"),
        {"companyId": company_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/agents", status_code=201)
def create_agent(
    body: AgentCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    _validate_json_field(body.businessHoursJson, "businessHoursJson", dict)
    _validate_json_field(body.funnelStagesJson, "funnelStagesJson", list)

    if body.isActive:
        _deactivate_other_agents(db, company_id)

    row = db.execute(
        text("""INSERT INTO ai_agents
            (company_id, name, persona, language, model, temperature, max_tokens, is_active,
             welcome_msg, offhours_msg, farewell_msg, business_hours_json, funnel_stages_json, created_at, updated_at)
            VALUES (:companyId, :name, :persona, :language, :model, :temperature, :maxTokens,
                    :isActive, :welcomeMsg, :offhoursMsg, :farewellMsg, :businessHoursJson, :funnelStagesJson, NOW(), NOW())
            RETURNING *"""),
        {
            "companyId": company_id, "name": body.name, "persona": body.persona,
            "language": body.language, "model": body.model, "temperature": body.temperature,
            "maxTokens": body.maxTokens, "isActive": body.isActive, "welcomeMsg": body.welcomeMsg,
            "offhoursMsg": body.offhoursMsg, "farewellMsg": body.farewellMsg,
            "businessHoursJson": body.businessHoursJson, "funnelStagesJson": body.funnelStagesJson,
        },
    ).mappings().first()

    db.commit()
    return dict(row) if row else None


@router.put("/agents/{agent_id}")
def update_agent(
    agent_id: int,
    body: AgentUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    _validate_json_field(body.businessHoursJson, "businessHoursJson", dict)
    _validate_json_field(body.funnelStagesJson, "funnelStagesJson", list)

    if body.isActive:
        _deactivate_other_agents(db, company_id, keep_id=agent_id)

    updates = []
    params = {"id": agent_id, "companyId": company_id}

    for field, db_field, value in [
        ("name", "name", body.name),
        ("persona", "persona", body.persona),
        ("language", "language", body.language),
        ("model", "model", body.model),
        ("temperature", "temperature", body.temperature),
        ("maxTokens", "max_tokens", body.maxTokens),
        ("isActive", "is_active", body.isActive),
        ("welcomeMsg", "welcome_msg", body.welcomeMsg),
        ("offhoursMsg", "offhours_msg", body.offhoursMsg),
        ("farewellMsg", "farewell_msg", body.farewellMsg),
        ("businessHoursJson", "business_hours_json", body.businessHoursJson),
        ("funnelStagesJson", "funnel_stages_json", body.funnelStagesJson),
        ("templateId", "template_id", body.templateId),
        ("templateVarsJson", "template_vars_json", body.templateVarsJson),
    ]:
        if value is not None:
            updates.append(f"{db_field} = :{field}")
            params[field] = value

    if updates:
        updates.append("updated_at = NOW()")
        db.execute(
            text(f"UPDATE ai_agents SET {', '.join(updates)} WHERE id = :id AND company_id = :companyId"),
            params,
        )

    agent = db.execute(
        text("SELECT * FROM ai_agents WHERE id = :id AND company_id = :companyId"),
        {"id": agent_id, "companyId": company_id},
    ).mappings().first()

    db.commit()
    return dict(agent) if agent else None


@router.delete("/agents/{agent_id}")
def delete_agent(
    agent_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    row = db.execute(
        text("DELETE FROM ai_agents WHERE id = :id AND company_id = :companyId RETURNING id"),
        {"id": agent_id, "companyId": company_id},
    ).mappings().first()
    db.commit()
    if not row:
        raise HTTPException(status_code=404, detail="agente no encontrado")
    return {"ok": True, "deletedId": agent_id}


# ── Agent test chat (dry-run, no persistence, no WhatsApp send) ───────

class AgentTestChatRequest(BaseModel):
    message: str
    history: list[dict[str, Any]] = []


@router.post("/agents/test-chat")
def agent_test_chat(
    body: AgentTestChatRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Preview how the active agent replies, without touching contacts,
    messages, WhatsApp, or traces. Lets non-technical users validate their
    persona/config before going live."""
    company_id = payload.get("companyId")
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message es requerido")

    from app.services.knowledge_base import get_ai_agent_config
    from app.services.rag_service import get_kb_context_for_prompt
    from app.core.config import settings as app_settings

    cfg = get_ai_agent_config(company_id)

    kb_text = ""
    try:
        kb_text, _cits = get_kb_context_for_prompt(query=message, company_id=company_id, max_chars=2500, top_k=4)
    except Exception:
        pass

    persona = (cfg.get("persona") or "Sos un asistente comercial. Respondé claro y breve.").strip()
    system_prompt = persona
    if kb_text:
        system_prompt += f"\n\nCONTEXTO DE LA BASE DE CONOCIMIENTO:\n{kb_text}"

    msgs = [{"role": "system", "content": system_prompt}]
    for h in (body.history or [])[-10:]:
        role = "assistant" if h.get("fromMe") else "user"
        content = str(h.get("body") or "").strip()
        if content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": message})

    if not app_settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY no configurada en el servidor")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=app_settings.openai_api_key)
        resp = client.chat.completions.create(
            model=cfg.get("model") or "gpt-4o-mini",
            messages=msgs,
            max_tokens=int(cfg.get("max_tokens") or 600),
            temperature=float(cfg.get("temperature") or 0.3),
        )
        reply = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error del modelo: {str(e)[:200]}")

    return {
        "reply": reply,
        "model": cfg.get("model") or "gpt-4o-mini",
        "agentName": cfg.get("name") or "",
        "usedKb": bool(kb_text),
    }


# ── Persona Templates ─────────────────────────────────────────────────

@router.get("/persona-templates")
def list_persona_templates(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        text('SELECT id, slug, name, category, description, placeholders, "templateBody", "welcomeMsgTemplate", "farewellMsgTemplate" FROM persona_templates WHERE "isActive" = TRUE ORDER BY id')
    ).mappings().all()
    return [dict(r) for r in rows]


# ── Tickets ───────────────────────────────────────────────────────────

@router.post("/tickets/{ticket_id}/toggle-bot")
def toggle_ticket_bot(
    ticket_id: int,
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    bot_enabled = body.get("botEnabled")
    human_override = body.get("humanOverride")

    set_clauses = []
    params = {"ticketId": ticket_id, "companyId": company_id}
    if isinstance(bot_enabled, bool):
        set_clauses.append("bot_enabled = :botEnabled")
        params["botEnabled"] = bot_enabled
    if isinstance(human_override, bool):
        set_clauses.append("human_override = :humanOverride")
        params["humanOverride"] = human_override

    if set_clauses:
        set_clauses.append('"updatedAt" = NOW()')
        db.execute(
            text(f'UPDATE tickets SET {", ".join(set_clauses)} WHERE id = :ticketId AND "companyId" = :companyId'),
            params,
        )
        db.commit()

    ticket = db.execute(
        text('SELECT id, status, bot_enabled, human_override FROM tickets WHERE id = :ticketId'),
        {"ticketId": ticket_id},
    ).mappings().first()

    return dict(ticket) if ticket else None


@router.get("/tickets/{ticket_id}/decisions")
def get_ticket_decisions(
    ticket_id: int,
    limit: int = Query(30, ge=1, le=100),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    try:
        rows = db.execute(
            text("""SELECT id, ticket_id, company_id, conversation_type, decision_key, reason, guardrail_action, response_preview, created_at
                 FROM ai_decision_logs
                 WHERE company_id = :companyId AND ticket_id = :ticketId
                 ORDER BY id DESC LIMIT :limit"""),
            {"companyId": company_id, "ticketId": ticket_id, "limit": limit},
        ).mappings().all()
        return [dict(row) for row in rows]
    except Exception:
        return []


# ── Funnel & Appointments ─────────────────────────────────────────────

@router.get("/funnel/stats")
def get_funnel_stats(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    row = db.execute(
        text("""SELECT
            SUM(CASE WHEN COALESCE(c.lead_score,0) < 25 THEN 1 ELSE 0 END)::int AS nuevo,
            SUM(CASE WHEN COALESCE(c.lead_score,0) >= 25 AND COALESCE(c.lead_score,0) < 50 THEN 1 ELSE 0 END)::int AS contactado,
            SUM(CASE WHEN COALESCE(c.lead_score,0) >= 50 AND COALESCE(c.lead_score,0) < 75 THEN 1 ELSE 0 END)::int AS calificado,
            SUM(CASE WHEN COALESCE(c.lead_score,0) >= 75 THEN 1 ELSE 0 END)::int AS interesado
         FROM contacts c WHERE c."companyId" = :companyId"""),
        {"companyId": company_id},
    ).mappings().first()

    return dict(row) if row else {"nuevo": 0, "contactado": 0, "calificado": 0, "interesado": 0}


@router.get("/appointments")
def list_appointments(
    from_date: str = Query(""),
    to_date: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    where_clauses = ["a.company_id = :companyId"]
    params = {"companyId": company_id}

    if from_date:
        where_clauses.append("a.starts_at >= :fromDate")
        params["fromDate"] = from_date
    if to_date:
        where_clauses.append("a.starts_at <= :toDate")
        params["toDate"] = to_date

    rows = db.execute(
        text(f"""SELECT a.*, c.name AS contact_name, c.number AS contact_number
             FROM appointments a
             JOIN contacts c ON c.id = a.contact_id
             WHERE {' AND '.join(where_clauses)}
             ORDER BY a.starts_at ASC LIMIT 500"""),
        params,
    ).mappings().all()

    return [dict(row) for row in rows]


class AppointmentCreate(BaseModel):
    contactId: int
    startsAt: str
    durationMin: int = 30
    serviceType: str = "general"
    notes: str = ""
    sendConfirmation: bool = True


class AppointmentStatusUpdate(BaseModel):
    status: str  # scheduled | completed | cancelled
    notifyContact: bool = False


@router.post("/appointments", status_code=201)
async def create_appointment(
    body: AppointmentCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Create an appointment from the Agenda UI. Optionally sends a WhatsApp
    confirmation immediately; the reminder loop then handles 24h/1h notices."""
    company_id = payload.get("companyId")

    contact = db.execute(
        text('SELECT id, name, number FROM contacts WHERE id = :id AND "companyId" = :cid LIMIT 1'),
        {"id": body.contactId, "cid": company_id},
    ).mappings().first()
    if not contact:
        raise HTTPException(status_code=404, detail="contacto no encontrado")

    try:
        starts = datetime.fromisoformat(body.startsAt.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail="startsAt inválido (ISO 8601)")

    duration = max(5, min(int(body.durationMin or 30), 480))
    row = db.execute(
        text("""INSERT INTO appointments
            (company_id, contact_id, starts_at, ends_at, service_type, status, notes, created_at, updated_at)
            VALUES (:cid, :contact, :starts, :starts + (:dur || ' minutes')::interval, :stype, 'scheduled', :notes, NOW(), NOW())
            RETURNING id, starts_at"""),
        {"cid": company_id, "contact": body.contactId, "starts": starts,
         "dur": duration, "stype": (body.serviceType or "general")[:255], "notes": body.notes or ""},
    ).mappings().first()
    db.commit()

    confirmation_sent = False
    if body.sendConfirmation and contact.get("number"):
        try:
            from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, send_whatsapp_message, save_message
            from app.services.appointment_reminders import _format_reminder
            wa = get_whatsapp_config(db, company_id)
            if wa:
                msg = _format_reminder(
                    "¡Hola {name}! Tu cita quedó confirmada para el {date} a las {time} hs.{notes_line} Te enviaremos un recordatorio antes. ¡Gracias!",
                    name=str(contact.get("name") or ""), starts_at=starts, notes=body.notes or "",
                )
                result = await send_whatsapp_message(str(contact["number"]), msg, wa)
                confirmation_sent = bool(result.get("ok"))
                if confirmation_sent:
                    try:
                        save_message(db, int(contact["id"]), msg, True, int(company_id))
                    except Exception:
                        pass
        except Exception as e:
            print(f"[appointments] confirmation send failed: {e}")

    return {"ok": True, "id": row["id"], "confirmationSent": confirmation_sent}


@router.put("/appointments/{appointment_id}")
async def update_appointment_status(
    appointment_id: int,
    body: AppointmentStatusUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    status_val = str(body.status or "").lower()
    if status_val not in ("scheduled", "completed", "cancelled"):
        raise HTTPException(status_code=400, detail="status inválido (scheduled|completed|cancelled)")

    appt = db.execute(
        text("""SELECT a.id, a.starts_at, a.notes, c.id AS contact_id, c.name AS contact_name, c.number AS contact_number
             FROM appointments a JOIN contacts c ON c.id = a.contact_id
             WHERE a.id = :id AND a.company_id = :cid LIMIT 1"""),
        {"id": appointment_id, "cid": company_id},
    ).mappings().first()
    if not appt:
        raise HTTPException(status_code=404, detail="cita no encontrada")

    db.execute(
        text("UPDATE appointments SET status = :st, updated_at = NOW() WHERE id = :id AND company_id = :cid"),
        {"st": status_val, "id": appointment_id, "cid": company_id},
    )
    db.commit()

    notified = False
    if body.notifyContact and status_val == "cancelled" and appt.get("contact_number"):
        try:
            from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, send_whatsapp_message, save_message
            from app.services.appointment_reminders import _format_reminder
            wa = get_whatsapp_config(db, company_id)
            if wa:
                msg = _format_reminder(
                    "Hola {name}, tu cita del {date} a las {time} hs fue cancelada. Si querés coordinar una nueva fecha, respondé este mensaje.",
                    name=str(appt.get("contact_name") or ""), starts_at=appt["starts_at"], notes="",
                )
                result = await send_whatsapp_message(str(appt["contact_number"]), msg, wa)
                notified = bool(result.get("ok"))
                if notified:
                    try:
                        save_message(db, int(appt["contact_id"]), msg, True, int(company_id))
                    except Exception:
                        pass
        except Exception as e:
            print(f"[appointments] cancel notify failed: {e}")

    return {"ok": True, "id": appointment_id, "status": status_val, "contactNotified": notified}


# ── Notes ─────────────────────────────────────────────────────────────

@router.get("/notes")
def list_notes(
    entityType: str = Query("ticket"),
    entityId: int = Query(...),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    rows = db.execute(
        text("SELECT * FROM internal_notes WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId ORDER BY id DESC"),
        {"companyId": company_id, "entityType": entityType, "entityId": entityId},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/notes", status_code=201)
def create_note(
    body: NoteCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    user_id = payload.get("id")
    mentions = _parse_mentions(body.content)

    row = db.execute(
        text("""INSERT INTO internal_notes (company_id, entity_type, entity_id, content, mentions_json, created_by, created_at, updated_at)
            VALUES (:companyId, :entityType, :entityId, :content, :mentionsJson, :createdBy, NOW(), NOW())
            RETURNING *"""),
        {"companyId": company_id, "entityType": body.entityType, "entityId": body.entityId,
         "content": body.content, "mentionsJson": json.dumps(mentions), "createdBy": user_id},
    ).mappings().first()

    db.commit()
    return dict(row) if row else None


@router.put("/notes/{note_id}")
def update_note(
    note_id: int,
    body: NoteUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    mentions = _parse_mentions(body.content)

    db.execute(
        text("UPDATE internal_notes SET content = :content, mentions_json = :mentionsJson, updated_at = NOW() WHERE id = :id AND company_id = :companyId"),
        {"id": note_id, "companyId": company_id, "content": body.content, "mentionsJson": json.dumps(mentions)},
    )

    note = db.execute(
        text("SELECT * FROM internal_notes WHERE id = :id AND company_id = :companyId"),
        {"id": note_id, "companyId": company_id},
    ).mappings().first()

    db.commit()
    return dict(note) if note else None


@router.delete("/notes/{note_id}")
def delete_note(
    note_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    db.execute(text("DELETE FROM internal_notes WHERE id = :id AND company_id = :companyId"), {"id": note_id, "companyId": company_id})
    db.commit()
    return {"ok": True, "deletedId": note_id}


# ── Dedupe ────────────────────────────────────────────────────────────

@router.get("/dedupe/candidates")
def get_dedupe_candidates(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    rows = db.execute(
        text(r"""WITH by_phone AS (
            SELECT 'phone'::text AS dedupe_key_type,
                   REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g') AS dedupe_key,
                   ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
                   COUNT(*)::int AS qty
            FROM contacts c
            WHERE c."companyId" = :companyId AND REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g') <> ''
            GROUP BY REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g')
            HAVING COUNT(*) > 1
        ),
        by_email AS (
            SELECT 'email'::text AS dedupe_key_type,
                   LOWER(TRIM(COALESCE(c.email,''))) AS dedupe_key,
                   ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
                   COUNT(*)::int AS qty
            FROM contacts c
            WHERE c."companyId" = :companyId AND LOWER(TRIM(COALESCE(c.email,''))) <> ''
            GROUP BY LOWER(TRIM(COALESCE(c.email,'')))
            HAVING COUNT(*) > 1
        )
        SELECT dedupe_key_type, dedupe_key, contact_ids, qty, (contact_ids[1]) AS primary_contact_id
        FROM (SELECT * FROM by_phone UNION ALL SELECT * FROM by_email) z
        ORDER BY qty DESC, dedupe_key_type ASC LIMIT 200"""),
        {"companyId": company_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/dedupe/merge")
def merge_dedupe_contacts(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    primary_contact_id = int(body.get("primaryContactId") or 0)
    secondary_contact_id = int(body.get("secondaryContactId") or 0)
    force = str(body.get("force") or "") == "1"

    if not primary_contact_id or not secondary_contact_id or primary_contact_id == secondary_contact_id:
        raise HTTPException(status_code=400, detail="primaryContactId y secondaryContactId válidos son requeridos")

    runtime = _get_runtime_settings()

    primary = db.execute(text('SELECT * FROM contacts WHERE id = :id AND "companyId" = :companyId LIMIT 1'), {"id": primary_contact_id, "companyId": company_id}).mappings().first()
    secondary = db.execute(text('SELECT * FROM contacts WHERE id = :id AND "companyId" = :companyId LIMIT 1'), {"id": secondary_contact_id, "companyId": company_id}).mappings().first()

    if not primary or not secondary:
        raise HTTPException(status_code=404, detail="contacto no encontrado")

    same_phone = _normalize_phone(primary["number"]) and _normalize_phone(primary["number"]) == _normalize_phone(secondary["number"])
    same_email = _normalize_email(primary["email"]) and _normalize_email(primary["email"]) == _normalize_email(secondary["email"])
    has_match = same_phone or same_email

    if not has_match and not force:
        raise HTTPException(status_code=422, detail="merge bloqueado: contactos sin key dedupe común (usar force=1 para override)")
    if runtime.get("dedupeStrictEmail") and not same_email and not force:
        raise HTTPException(status_code=422, detail="merge bloqueado por dedupeStrictEmail: emails no coinciden")

    db.execute(text('UPDATE tickets SET "contactId" = :primaryId WHERE "contactId" = :secondaryId AND "companyId" = :companyId'), {"primaryId": primary_contact_id, "secondaryId": secondary_contact_id, "companyId": company_id})
    db.execute(text('UPDATE messages SET "contactId" = :primaryId WHERE "contactId" = :secondaryId'), {"primaryId": primary_contact_id, "secondaryId": secondary_contact_id})
    db.execute(text('INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt") SELECT :primaryId, ct."tagId", NOW(), NOW() FROM contact_tags ct WHERE ct."contactId" = :secondaryId ON CONFLICT ("contactId", "tagId") DO NOTHING'), {"primaryId": primary_contact_id, "secondaryId": secondary_contact_id})

    merged_name = str(primary["name"] or secondary["name"] or "")
    merged_email = str(primary["email"] or secondary["email"] or "")
    merged_number = str(primary["number"] or secondary["number"] or "")
    merged_needs = "\n".join(filter(None, [str(primary.get("needs") or ""), str(secondary.get("needs") or "")]))[:900]
    merged_score = max(float(primary.get("lead_score") or 0), float(secondary.get("lead_score") or 0))

    db.execute(text('UPDATE contacts SET name = :name, email = :email, number = :number, needs = :needs, lead_score = :leadScore, "updatedAt" = NOW() WHERE id = :id AND "companyId" = :companyId'), {"id": primary_contact_id, "companyId": company_id, "name": merged_name, "email": merged_email, "number": merged_number, "needs": merged_needs, "leadScore": merged_score})
    db.execute(text('DELETE FROM contacts WHERE id = :id AND "companyId" = :companyId'), {"id": secondary_contact_id, "companyId": company_id})
    db.commit()

    return {"ok": True, "primaryContactId": primary_contact_id, "mergedFrom": secondary_contact_id, "matchedBy": {"samePhone": same_phone, "sameEmail": same_email}, "forced": force}


# ── Leads ─────────────────────────────────────────────────────────────

@router.post("/leads/{contact_id}/recalculate-score")
def recalculate_lead_score(
    contact_id: int,
    body: LeadRecalculateScoreRequest = None,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    user_id = payload.get("id")
    body = body or LeadRecalculateScoreRequest()

    contact = db.execute(
        text('SELECT id, name, email, number, tags, source, lead_score, "leadStatus" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1'),
        {"contactId": contact_id, "companyId": company_id},
    ).mappings().first()

    if not contact:
        raise HTTPException(status_code=404, detail="contacto no encontrado")

    interactions_result = db.execute(text('SELECT COUNT(*)::int AS qty FROM messages WHERE "contactId" = :contactId'), {"contactId": contact_id}).mappings().first()
    interactions = body.interactions if body.interactions is not None else int(interactions_result["qty"]) if interactions_result else 0

    inactive_result = db.execute(text('SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX("createdAt"), NOW()))) / 86400 AS days FROM messages WHERE "contactId" = :contactId'), {"contactId": contact_id}).mappings().first()
    inactive_days = body.inactiveDays if body.inactiveDays is not None else int(float(inactive_result["days"])) if inactive_result and inactive_result["days"] else 0

    source = body.source or str(contact.get("source") or "")
    tags = body.tags if body.tags is not None else _parse_tags(contact.get("tags"))
    new_score = _score_lead(source=source, interactions=interactions, inactive_days=inactive_days, tags=tags)
    new_status = "hot" if new_score >= 75 else "warm" if new_score >= 50 else "engaged" if new_score >= 25 else "new"

    db.execute(text('UPDATE contacts SET lead_score = :leadScore, "leadStatus" = :leadStatus, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId'), {"contactId": contact_id, "companyId": company_id, "leadScore": new_score, "leadStatus": new_status})

    db.execute(
        text("""INSERT INTO lead_score_events (company_id, contact_id, previous_score, new_score, previous_status, new_status, reason, payload_json, created_by, created_at)
            VALUES (:companyId, :contactId, :previousScore, :newScore, :previousStatus, :newStatus, :reason, :payloadJson, :createdBy, NOW())"""),
        {"companyId": company_id, "contactId": contact_id, "previousScore": int(float(contact.get("lead_score") or 0)), "newScore": new_score,
         "previousStatus": str(contact.get("leadStatus") or contact.get("lead_status") or "new"), "newStatus": new_status,
         "reason": body.reason or "recalculate", "payloadJson": json.dumps({"source": source, "interactions": interactions, "inactiveDays": inactive_days, "tags": tags}), "createdBy": user_id},
    )
    db.commit()

    return {"ok": True, "contactId": contact_id, "leadScore": new_score, "leadStatus": new_status, "inputs": {"source": source, "interactions": interactions, "inactiveDays": inactive_days, "tags": tags}}


@router.get("/leads/{contact_id}/score-history")
def get_lead_score_history(
    contact_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    rows = db.execute(
        text("""SELECT id, previous_score, new_score, previous_status, new_status, reason, payload_json, created_by, created_at
             FROM lead_score_events WHERE company_id = :companyId AND contact_id = :contactId ORDER BY id DESC LIMIT 100"""),
        {"companyId": company_id, "contactId": contact_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/leads/{contact_id}/close")
@router.post("/leads/{contact_id}/status")
def update_lead_status(
    contact_id: int,
    body: LeadStatusRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    status = str(body.status or "lost").lower()
    loss_reason = str(body.lossReason or "").strip()

    normalized_status = "lost" if status == "perdido" else status
    valid_statuses = ["lost", "won", "read", "engaged", "warm", "hot", "new"]
    if normalized_status not in valid_statuses:
        raise HTTPException(status_code=400, detail="status inválido")
    if normalized_status == "lost" and not loss_reason:
        raise HTTPException(status_code=400, detail="lossReason obligatorio para lead perdido")

    contact = db.execute(text('SELECT id, name, number, email, needs FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1'), {"contactId": contact_id, "companyId": company_id}).mappings().first()
    if not contact:
        raise HTTPException(status_code=404, detail="contacto no encontrado")

    merged_needs = "\n".join(filter(None, [str(contact.get("needs") or ""), f"\n[LOSS_REASON] {loss_reason}" if loss_reason else ""]))[:900]

    db.execute(
        text('UPDATE contacts SET "leadStatus" = :leadStatus, needs = :needs, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId'),
        {"contactId": contact_id, "companyId": company_id, "leadStatus": "customer" if normalized_status == "won" else normalized_status, "needs": merged_needs},
    )
    db.commit()

    return {"ok": True, "contactId": contact_id, "status": normalized_status, "lossReason": loss_reason or None}


@router.put("/contacts/{contact_id}/status")
def update_contact_status(
    contact_id: int,
    body: LeadStatusRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    return update_lead_status(contact_id, body, payload, db)
