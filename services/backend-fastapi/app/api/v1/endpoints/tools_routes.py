"""Tool manifest, MCP tools, and tool execution endpoint."""
import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, get_db
from app.api.v1.endpoints._ai_shared import (
    ToolExecuteRequest, TOOL_MANIFEST,
    _score_from_text, _infer_lead_status_by_signals,
)

router = APIRouter()


@router.get("/tools/manifest")
def get_tools_manifest(payload: dict = Depends(get_current_user_payload)):
    return {"ok": True, "tools": TOOL_MANIFEST}


@router.get("/mcp/tools")
def get_mcp_tools(payload: dict = Depends(get_current_user_payload)):
    return {"ok": True, "tools": TOOL_MANIFEST, "protocol": "mcp-like"}


@router.post("/tools/execute")
def execute_tool(
    body: ToolExecuteRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    user_id = payload.get("id")
    tool = body.tool
    args = body.args or {}

    def fail(error: str, status: int = 400):
        raise HTTPException(status_code=status, detail=error)

    try:
        if tool == "upsert_contact":
            number = re.sub(r"\D", "", str(args.get("number", "")))
            if not number:
                fail("number requerido")

            existing = db.execute(
                text('SELECT * FROM contacts WHERE "companyId" = :companyId AND number = :number LIMIT 1'),
                {"companyId": company_id, "number": number},
            ).mappings().first()

            if existing:
                db.execute(
                    text('UPDATE contacts SET name = COALESCE(:name, name), email = COALESCE(:email, email), business_type = COALESCE(:businessType, business_type), needs = COALESCE(:needs, needs), "updatedAt" = NOW() WHERE id = :id'),
                    {"id": existing["id"], "name": args.get("name"), "email": args.get("email"), "businessType": args.get("businessType"), "needs": args.get("needs")},
                )
            else:
                db.execute(
                    text('INSERT INTO contacts (name, number, email, isGroup, "companyId", business_type, needs, lead_score, createdAt, "updatedAt") VALUES (:name, :number, :email, false, :companyId, :businessType, :needs, :leadScore, NOW(), NOW())'),
                    {"name": args.get("name") or number, "number": number, "email": args.get("email") or "", "companyId": company_id, "businessType": args.get("businessType"), "needs": args.get("needs"), "leadScore": int(args.get("leadScore") or 0)},
                )
            db.commit()
            return {"ok": True, "tool": tool, "result": "contact upserted"}

        if tool == "actualizar_lead_score":
            contact_id = int(args.get("contactId") or 0)
            ticket_id = int(args.get("ticketId") or 0)
            inbound_text = str(args.get("inboundText") or args.get("text") or "").strip()

            if not contact_id and ticket_id:
                t = db.execute(text('SELECT "contactId" FROM tickets WHERE id = :ticketId AND "companyId" = :companyId LIMIT 1'), {"ticketId": ticket_id, "companyId": company_id}).mappings().first()
                contact_id = int(t["contactId"]) if t else 0

            if not contact_id:
                fail("contactId o ticketId requerido")

            existing = db.execute(text('SELECT lead_score, "leadStatus" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1'), {"contactId": contact_id, "companyId": company_id}).mappings().first()
            explicit_score = float(args.get("leadScore")) if args.get("leadScore") is not None else None
            lead_score = explicit_score if explicit_score is not None else _score_from_text(inbound_text, float(existing["lead_score"] or 0) if existing else 0)
            lead_status = _infer_lead_status_by_signals(inbound_text, lead_score, str(existing["leadStatus"] or "") if existing else "")

            db.execute(text('UPDATE contacts SET lead_score = :leadScore, "leadStatus" = :leadStatus, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId'), {"contactId": contact_id, "companyId": company_id, "leadScore": lead_score, "leadStatus": lead_status})
            db.commit()
            return {"ok": True, "tool": tool, "result": {"contactId": contact_id, "leadScore": lead_score, "leadStatus": lead_status}}

        if tool == "agregar_nota":
            ticket_id = int(args.get("ticketId") or 0)
            note = str(args.get("note") or "").strip()
            if not ticket_id or not note:
                fail("ticketId y note requeridos")

            db.execute(
                text("""INSERT INTO ai_turns (conversation_id, role, content, model, latency_ms, tokens_in, tokens_out, created_at, updated_at)
                    VALUES (NULL, 'tool', :content, 'manual-note', 0, 0, 0, NOW(), NOW())"""),
                {"content": f"[ticket:{ticket_id}] {note}"},
            )
            db.commit()
            return {"ok": True, "tool": tool, "result": "note saved"}

        if tool == "agendar_cita":
            contact_id = int(args.get("contactId") or 0)
            starts_at = str(args.get("startsAt") or "")
            duration_min = int(args.get("durationMin") or 30)
            if not contact_id or not starts_at:
                fail("contactId y startsAt requeridos")

            from datetime import timedelta
            end = (datetime.fromisoformat(starts_at.replace("Z", "+00:00")) + timedelta(minutes=duration_min)).isoformat() if "T" in starts_at else starts_at

            appt = db.execute(
                text("""INSERT INTO appointments (company_id, contact_id, ticket_id, starts_at, ends_at, service_type, status, notes, created_at, updated_at)
                    VALUES (:companyId, :contactId, :ticketId, :startsAt, :endsAt, :serviceType, 'scheduled', :notes, NOW(), NOW())
                    RETURNING *"""),
                {"companyId": company_id, "contactId": contact_id, "ticketId": args.get("ticketId"), "startsAt": starts_at, "endsAt": end, "serviceType": args.get("serviceType") or "general", "notes": args.get("notes") or ""},
            ).mappings().first()

            db.execute(
                text("""INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
                    VALUES (:appointmentId, 'create', '', :createdBy, NOW(), NOW())"""),
                {"appointmentId": appt["id"], "createdBy": user_id},
            )
            db.commit()
            return {"ok": True, "tool": tool, "result": dict(appt)}

        if tool == "reprogramar_cita":
            appointment_id = int(args.get("appointmentId") or 0)
            starts_at = str(args.get("startsAt") or "")
            duration_min = int(args.get("durationMin") or 30)
            if not appointment_id or not starts_at:
                fail("appointmentId y startsAt requeridos")

            from datetime import timedelta
            end = (datetime.fromisoformat(starts_at.replace("Z", "+00:00")) + timedelta(minutes=duration_min)).isoformat() if "T" in starts_at else starts_at

            db.execute(
                text("UPDATE appointments SET starts_at = :startsAt, ends_at = :endsAt, status='rescheduled', updated_at = NOW() WHERE id = :appointmentId AND company_id = :companyId"),
                {"appointmentId": appointment_id, "companyId": company_id, "startsAt": starts_at, "endsAt": end},
            )
            db.execute(
                text("""INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
                    VALUES (:appointmentId, 'reschedule', :reason, :createdBy, NOW(), NOW())"""),
                {"appointmentId": appointment_id, "reason": str(args.get("reason") or ""), "createdBy": user_id},
            )
            db.commit()
            return {"ok": True, "tool": tool, "result": "appointment rescheduled"}

        if tool == "cancelar_cita":
            appointment_id = int(args.get("appointmentId") or 0)
            if not appointment_id:
                fail("appointmentId requerido")

            db.execute(text("UPDATE appointments SET status='cancelled', updated_at = NOW() WHERE id = :appointmentId AND company_id = :companyId"), {"appointmentId": appointment_id, "companyId": company_id})
            db.execute(
                text("""INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
                    VALUES (:appointmentId, 'cancel', :reason, :createdBy, NOW(), NOW())"""),
                {"appointmentId": appointment_id, "reason": str(args.get("reason") or ""), "createdBy": user_id},
            )
            db.commit()
            return {"ok": True, "tool": tool, "result": "appointment cancelled"}

        if tool == "consultar_conocimiento":
            query = str(args.get("query", ""))
            rows = db.execute(
                text("""SELECT c.chunk_text, d.title, d.category,
                                (CASE WHEN POSITION(LOWER(:query) IN LOWER(c.chunk_text)) > 0 THEN 0.95 ELSE 0.50 END) AS similarity
                         FROM kb_chunks c
                         JOIN kb_documents d ON d.id = c.document_id
                         WHERE d.company_id = :companyId AND LOWER(c.chunk_text) LIKE LOWER(:qLike)
                         ORDER BY similarity DESC LIMIT 5"""),
                {"companyId": company_id, "query": query, "qLike": f"%{query}%"},
            ).mappings().all()
            return {"ok": True, "tool": tool, "result": [dict(r) for r in rows]}

        fail(f"tool no soportada: {tool}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
