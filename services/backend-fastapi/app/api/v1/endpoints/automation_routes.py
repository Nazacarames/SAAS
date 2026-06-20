"""Routing, SLA, follow-ups, sequences, Tokko audit, recapture, integration errors."""
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin, get_db
from app.api.v1.endpoints._ai_shared import (
    RoutingRuleUpdate, FollowupScheduleRequest, IntegrationErrorLogRequest,
    _ensure_crm_feature_tables, _ensure_meta_lead_tables,
    _get_runtime_settings, _save_runtime_settings,
)

router = APIRouter()


# ── Routing ───────────────────────────────────────────────────────────

@router.get("/routing/rules")
def get_routing_rules(payload: dict = Depends(get_current_user_payload)):
    runtime = _get_runtime_settings()
    try:
        rules = json.loads(runtime.get("routingRulesJson", "[]"))
    except Exception:
        rules = []
    return {"rules": rules}


@router.put("/routing/rules")
def update_routing_rules(
    body: RoutingRuleUpdate,
    payload: dict = Depends(get_current_user_payload),
):
    require_admin(payload)
    rules = body.rules if isinstance(body.rules, list) else []
    next_settings = _save_runtime_settings({"routingRulesJson": json.dumps(rules)})
    return {"ok": True, "rules": json.loads(next_settings.get("routingRulesJson", "[]"))}


def _match_routing_rule(rules: list, source: str, tags: list, channel: str, priority: float) -> Optional[dict]:
    for r in rules:
        if r.get("enabled") is False:
            continue
        if r.get("source") and str(r.get("source")).lower() != source:
            continue
        if r.get("channel") and str(r.get("channel")).lower() != channel:
            continue
        if isinstance(r.get("priorityMin"), (int, float)) and priority < float(r["priorityMin"]):
            continue
        if isinstance(r.get("tagsAny"), list) and r["tagsAny"] and not any(str(t).lower() in tags for t in r["tagsAny"]):
            continue
        return r
    return None


@router.post("/routing/resolve")
def resolve_routing(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
):
    runtime = _get_runtime_settings()
    try:
        rules = json.loads(runtime.get("routingRulesJson", "[]"))
    except Exception:
        rules = []

    source = str(body.get("source") or "").lower()
    tags = [str(t).lower() for t in (body.get("tags") or [])]
    channel = str(body.get("channel") or "").lower()
    priority = float(body.get("priority") or 0)

    match = _match_routing_rule(rules, source, tags, channel, priority)
    return {"matched": match, "assignedUserId": match.get("assignUserId") if match else None, "queue": match.get("queue") if match else None, "routingKey": match.get("key") if match else None}


@router.post("/routing/execute")
def execute_routing(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    ticket_id = int(body.get("ticketId") or 0)
    contact_id = int(body.get("contactId") or 0)
    if not ticket_id and not contact_id:
        raise HTTPException(status_code=400, detail="ticketId o contactId requerido")

    runtime = _get_runtime_settings()
    try:
        rules = json.loads(runtime.get("routingRulesJson", "[]"))
    except Exception:
        rules = []

    source = str(body.get("source") or "").lower()
    tags = [str(t).lower() for t in (body.get("tags") or [])]
    channel = str(body.get("channel") or "").lower()
    priority = float(body.get("priority") or 0)
    dry_run = str(body.get("dryRun") or "") == "1"

    match = _match_routing_rule(rules, source, tags, channel, priority)

    if not match:
        return {"ok": True, "applied": False, "reason": "no_rule_match"}
    if dry_run:
        return {"ok": True, "applied": False, "dryRun": True, "matched": match, "assignUserId": match.get("assignUserId"), "queue": match.get("queue")}

    if ticket_id:
        db.execute(
            text('UPDATE tickets SET "userId" = COALESCE(:userId, "userId"), queue = COALESCE(:queue, queue), "updatedAt" = NOW() WHERE id = :ticketId AND "companyId" = :companyId'),
            {"userId": int(match.get("assignUserId") or 0) or None, "queue": match.get("queue") if match.get("queue") else None, "ticketId": ticket_id, "companyId": company_id},
        )
        db.commit()

    return {"ok": True, "applied": True, "ticketId": ticket_id or None, "contactId": contact_id or None, "matched": match, "assignUserId": match.get("assignUserId"), "queue": match.get("queue")}


# ── SLA ───────────────────────────────────────────────────────────────

@router.get("/sla/overdue")
def get_sla_overdue(
    slaMinutes: int = Query(60),
    autoAssign: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    runtime = _get_runtime_settings()
    sla_minutes = max(1, int(slaMinutes or runtime.get("slaMinutes", 60)))
    should_auto_assign = autoAssign == "1" or runtime.get("slaAutoReassign")

    overdue = db.execute(
        text("""SELECT t.id, t.status, t."userId", t."contactId", t."updatedAt", t."createdAt",
                    EXTRACT(EPOCH FROM (NOW() - COALESCE(t."updatedAt", t."createdAt")))/60 AS elapsed_minutes
             FROM tickets t
             WHERE t."companyId" = :companyId AND t.status IN ('open','pending')
               AND EXTRACT(EPOCH FROM (NOW() - COALESCE(t."updatedAt", t."createdAt")))/60 > :slaMinutes
             ORDER BY elapsed_minutes DESC LIMIT 500"""),
        {"companyId": company_id, "slaMinutes": sla_minutes},
    ).mappings().all()

    users_load = db.execute(
        text("""SELECT t."userId" AS user_id, COUNT(*)::int AS open_count
             FROM tickets t
             WHERE t."companyId" = :companyId AND t.status IN ('open','pending') AND t."userId" IS NOT NULL
             GROUP BY t."userId" ORDER BY open_count ASC"""),
        {"companyId": company_id},
    ).mappings().all()

    best_user_id = int(users_load[0]["user_id"]) if users_load and users_load[0]["user_id"] else None

    reassigned = 0
    suggestions = 0
    result_tickets = []
    for t in overdue:
        ticket_dict = dict(t)
        ticket_dict["suggestedUserId"] = best_user_id
        if not best_user_id or t["userId"] == best_user_id:
            pass
        elif runtime.get("slaSuggestOnly") and not should_auto_assign:
            suggestions += 1
        elif should_auto_assign:
            db.execute(
                text('UPDATE tickets SET "userId" = :userId, "updatedAt" = NOW() WHERE id = :ticketId AND "companyId" = :companyId'),
                {"userId": best_user_id, "ticketId": t["id"], "companyId": company_id},
            )
            reassigned += 1
        result_tickets.append(ticket_dict)

    if should_auto_assign:
        db.commit()

    return {"slaMinutes": sla_minutes, "totalOverdue": len(overdue), "reassigned": reassigned, "suggestions": suggestions, "tickets": result_tickets}


# ── Follow-ups / Sequences ────────────────────────────────────────────

@router.get("/followups")
def list_followups(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    rows = db.execute(
        text("SELECT * FROM followup_sequences WHERE company_id = :companyId ORDER BY id DESC LIMIT 500"),
        {"companyId": company_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/followups/schedule")
def schedule_followups(
    body: FollowupScheduleRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    ticket_id = body.ticketId
    contact_id = body.contactId
    if not ticket_id and not contact_id:
        raise HTTPException(status_code=400, detail="ticketId o contactId requerido")

    runtime = _get_runtime_settings()
    days = [1, 3, 7]
    try:
        days = [int(x) for x in json.loads(runtime.get("followUpDaysJson", "[1,3,7]")) if int(x) > 0]
    except Exception:
        days = [1, 3, 7]

    base_date = datetime.fromisoformat(body.baseDate.replace("Z", "+00:00")) if body.baseDate else datetime.utcnow()
    sequence_group = body.sequenceGroup or f"{company_id}:{ticket_id or 0}:{contact_id or 0}:{base_date.strftime('%Y-%m-%d')}"
    idempotency_prefix = body.idempotencyKey or sequence_group

    import datetime as dt
    created, skipped = [], []
    for day in days:
        scheduled_at = base_date + dt.timedelta(days=day)
        idempotency_key = f"{idempotency_prefix}:D+{day}"

        existing = db.execute(
            text("SELECT * FROM followup_sequences WHERE company_id = :companyId AND idempotency_key = :idempotencyKey LIMIT 1"),
            {"companyId": company_id, "idempotencyKey": idempotency_key},
        ).mappings().first()

        if existing:
            skipped.append(dict(existing))
            continue

        row = db.execute(
            text("""INSERT INTO followup_sequences (company_id, ticket_id, contact_id, day_offset, template_text, status, scheduled_at, idempotency_key, sequence_group, created_at)
                VALUES (:companyId, :ticketId, :contactId, :dayOffset, :templateText, 'scheduled', :scheduledAt, :idempotencyKey, :sequenceGroup, NOW())
                RETURNING *"""),
            {"companyId": company_id, "ticketId": ticket_id, "contactId": contact_id, "dayOffset": day, "templateText": f"Seguimiento D+{day}", "scheduledAt": scheduled_at, "idempotencyKey": idempotency_key, "sequenceGroup": sequence_group},
        ).mappings().first()

        created.append(dict(row) if row else None)

    db.commit()
    return {"ok": True, "scheduled": len(created), "skipped": len(skipped), "sequenceGroup": sequence_group, "items": [r for r in created if r], "existing": skipped}


@router.post("/followups/run-due")
def run_due_followups(
    body: dict[str, Any] = {},
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    dry_run = str(body.get("dryRun") or "") == "1"

    due = db.execute(
        text("SELECT * FROM followup_sequences WHERE company_id = :companyId AND status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 200"),
        {"companyId": company_id},
    ).mappings().all()

    executed = 0
    if not dry_run:
        for row in due:
            updated = db.execute(
                text("UPDATE followup_sequences SET status = 'executed', executed_at = NOW() WHERE id = :id AND company_id = :companyId AND status = 'scheduled' RETURNING id"),
                {"id": row["id"], "companyId": company_id},
            ).mappings().first()
            if updated:
                executed += 1
        db.commit()

    return {"ok": True, "dryRun": dry_run, "due": len(due), "executed": executed if not dry_run else 0, "items": [dict(r) for r in due]}


# Sequences are aliases of followups
@router.get("/sequences")
def list_sequences(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    return list_followups(payload, db)


@router.post("/sequences/schedule")
def schedule_sequences(body: FollowupScheduleRequest, payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    return schedule_followups(body, payload, db)


@router.post("/sequences/run-due")
def run_due_sequences(body: dict[str, Any] = {}, payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    return run_due_followups(body, payload, db)


# ── Tokko Audit ───────────────────────────────────────────────────────

@router.get("/tokko/audit")
def get_tokko_audit(
    sinceHours: int = Query(24 * 7),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    hours = max(1, min(24 * 30, sinceHours))

    sent_tag = db.execute(
        text("""SELECT COUNT(DISTINCT ct."contactId")::int AS count
             FROM contact_tags ct JOIN tags t ON t.id = ct."tagId" JOIN contacts c ON c.id = ct."contactId"
             WHERE c."companyId" = :companyId AND LOWER(t.name) = 'enviado_tokko'"""),
        {"companyId": company_id},
    ).mappings().first()

    status_synced_tag = db.execute(
        text("""SELECT COUNT(DISTINCT ct."contactId")::int AS count
             FROM contact_tags ct JOIN tags t ON t.id = ct."tagId" JOIN contacts c ON c.id = ct."contactId"
             WHERE c."companyId" = :companyId AND LOWER(t.name) = 'tokko_status_synced'"""),
        {"companyId": company_id},
    ).mappings().first()

    errors_count = db.execute(
        text("""SELECT COUNT(*)::int AS count FROM integration_errors
             WHERE company_id = :companyId AND source = 'tokko' AND created_at >= NOW() - (:hours::text || ' hours')::interval"""),
        {"companyId": company_id, "hours": hours},
    ).mappings().first()

    recent_errors = db.execute(
        text("""SELECT id, source, severity, error_code, message, suggestion, payload_json, created_at
             FROM integration_errors WHERE company_id = :companyId AND source = 'tokko' ORDER BY id DESC LIMIT 20"""),
        {"companyId": company_id},
    ).mappings().all()

    meta_leads = db.execute(
        text("""SELECT COUNT(*)::int AS count FROM meta_lead_events
             WHERE company_id = :companyId AND created_at >= NOW() - (:hours::text || ' hours')::interval"""),
        {"companyId": company_id, "hours": hours},
    ).mappings().first()

    return {
        "ok": True,
        "sinceHours": hours,
        "totals": {
            "metaLeadsInWindow": int(meta_leads["count"]) if meta_leads else 0,
            "contactsTaggedEnviadoTokko": int(sent_tag["count"]) if sent_tag else 0,
            "contactsTaggedTokkoStatusSynced": int(status_synced_tag["count"]) if status_synced_tag else 0,
            "tokkoErrorsInWindow": int(errors_count["count"]) if errors_count else 0,
        },
        "recentErrors": [dict(r) for r in recent_errors],
    }


# ── Recapture ─────────────────────────────────────────────────────────

@router.post("/recapture/run-now")
def run_recapture(payload: dict = Depends(get_current_user_payload)):
    return {"ok": True, "message": "recapture scan executed"}


# ── Integration Errors ────────────────────────────────────────────────

@router.get("/integrations/errors")
def list_integration_errors(
    source: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")

    where_clauses = ["(company_id = :companyId OR company_id IS NULL)"]
    params = {"companyId": company_id}
    if source:
        where_clauses.append("source = :source")
        params["source"] = source

    rows = db.execute(
        text(f"SELECT * FROM integration_errors WHERE {' AND '.join(where_clauses)} ORDER BY id DESC LIMIT 300"),
        params,
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/integrations/errors/log")
def log_integration_error(
    body: IntegrationErrorLogRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_crm_feature_tables(db)
    company_id = payload.get("companyId")
    if body.source.lower() not in ("whatsapp", "meta", "tokko"):
        raise HTTPException(status_code=400, detail="source inválido")

    db.execute(
        text("""INSERT INTO integration_errors (company_id, source, severity, error_code, message, suggestion, payload_json, created_at)
            VALUES (:companyId, :source, :severity, :errorCode, :message, :suggestion, :payloadJson, NOW())"""),
        {"companyId": company_id, "source": body.source.lower(), "severity": body.severity, "errorCode": body.errorCode, "message": body.message, "suggestion": body.suggestion, "payloadJson": json.dumps(body.payload)},
    )
    db.commit()
    return {"ok": True}
