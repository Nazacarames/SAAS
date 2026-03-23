import json
import re
import hashlib
import hmac
import math
import threading
from datetime import datetime, timezone
from typing import Any, Optional
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Header, Query, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin, get_db
from app.core.config import settings

router = APIRouter(prefix="/api/ai", tags=["ai"])

# ── Helpers ─────────────────────────────────────────────────────────

GRAPH_API_VERSION = "v21.0"

_SETTINGS_FILE = Path(__file__).parent.parent.parent.parent / "runtime-settings.json"


def _read_runtime_settings() -> dict[str, Any]:
    if not _SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(_SETTINGS_FILE.read_text() or "{}")
    except Exception:
        return {}


def _save_runtime_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = _read_runtime_settings()
    next_settings = {**current, **patch}
    _SETTINGS_FILE.write_text(json.dumps(next_settings, indent=2))
    return next_settings


def _get_runtime_settings() -> dict[str, Any]:
    return _read_runtime_settings()


def _score_from_text(text: str, current: int = 0) -> int:
    score = current
    if re.search(r"comprar|contratar|precio|plan|cotiz|demo", text, re.IGNORECASE):
        score = max(score, 65)
    if re.search(r"urgente|hoy|ahora|ya", text, re.IGNORECASE):
        score = max(score, 78)
    if re.search(r"presupuesto|interesa|quiero", text, re.IGNORECASE):
        score = max(score, 72)
    if re.search(r"gracias|resuelto|listo", text, re.IGNORECASE):
        score = max(score, 45)
    return min(100, score)


def _infer_lead_status_by_signals(text: str, lead_score: int, current_status: str = "") -> str:
    t = text.lower()
    curr = current_status.lower().strip()

    if re.search(r"reserva|seña|senia|cerrar|firma|boleto|avanzamos|quiero avanzar|quiero cerrar", t):
        return "cierre"
    if re.search(r"enviar propuesta|te envío propuesta|propuesta|cotización|cotizacion|financiación|financiacion|plan de pago", t):
        return "propuesta"
    if re.search(r"visita|tour|recorrido|agendar|agenda|llamar|llamada|reunión|reunion|cuando puedo ir", t):
        return "calificacion"
    if re.search(r"hola|buenas|info|información|informacion|consulta|me interesa|quiero saber", t):
        return "primer_contacto"
    if re.search(r"dejalo|después|despues|más tarde|mas tarde|no ahora", t):
        return "esperando_respuesta"

    if lead_score >= 85:
        return "cierre"
    if lead_score >= 65:
        return "propuesta"
    if lead_score >= 40:
        return "calificacion"
    if lead_score >= 20:
        return "primer_contacto"

    return curr or "nuevo_ingreso"


def _score_lead(source: str = "", interactions: int = 0, inactive_days: int = 0, tags: list[str] = None) -> int:
    tags = tags or []
    score = 20
    if re.search(r"meta|ads|referido|organic", source, re.IGNORECASE):
        score += 20
    score += min(30, max(0, interactions) * 3)
    score -= min(30, max(0, inactive_days) * 2)
    if any(re.search(r"vip|hot|inversor|urgente", str(t), re.IGNORECASE) for t in tags):
        score += 20
    if any(re.search(r"spam|baja|no_interesado", str(t), re.IGNORECASE) for t in tags):
        score -= 25
    return max(0, min(100, round(score)))


def _parse_mentions(text: str) -> list[str]:
    return list(set(re.findall(r"@([a-zA-Z0-9_.-]{2,40})", text)))


def _render_template(template: str, variables: dict[str, Any]) -> str:
    return re.sub(r"{{\\s*([a-zA-Z0-9_.-]+)\\s*}}", lambda m: str(variables.get(m.group(1), "")), template)


def _normalize_phone(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _parse_tags(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(x or "").strip() for x in value if x]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(x or "").strip() for x in parsed if x]
        except Exception:
            pass
        return [x.strip() for x in value.split(",") if x.strip()]
    return []


# ── Table initialization (thread-safe) ─────────────────────────────────

_meta_oauth_tables_ready = False
_meta_lead_tables_ready = False
_template_tables_ready = False
_crm_feature_tables_ready = False
_table_init_locks = {
    "meta_oauth": threading.Lock(),
    "meta_lead": threading.Lock(),
    "template": threading.Lock(),
    "crm": threading.Lock(),
}


def _ensure_meta_oauth_tables(db: Session) -> None:
    global _meta_oauth_tables_ready
    if _meta_oauth_tables_ready:
        return
    with _table_init_locks["meta_oauth"]:
        if _meta_oauth_tables_ready:
            return

        db.execute(text("""CREATE TABLE IF NOT EXISTS meta_oauth_states (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            user_id INTEGER,
            nonce VARCHAR(120) NOT NULL,
            state_hash VARCHAR(120) NOT NULL UNIQUE,
            redirect_after VARCHAR(700),
            status VARCHAR(40) NOT NULL DEFAULT 'pending',
            used_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL
        )"""))

        db.execute(text("""CREATE TABLE IF NOT EXISTS meta_connections (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            meta_business_id VARCHAR(120),
            waba_id VARCHAR(120),
            phone_number_id VARCHAR(120),
            phone_number_display VARCHAR(120),
            access_token TEXT NOT NULL,
            token_type VARCHAR(40),
            token_expires_at TIMESTAMP WITH TIME ZONE,
            scopes_json TEXT NOT NULL DEFAULT '[]',
            webhook_verified_at TIMESTAMP WITH TIME ZONE,
            status VARCHAR(40) NOT NULL DEFAULT 'connected',
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("CREATE INDEX IF NOT EXISTS idx_meta_connections_company ON meta_connections(company_id, id DESC)"))
        db.commit()
        _meta_oauth_tables_ready = True


def _ensure_meta_lead_tables(db: Session) -> None:
    global _meta_lead_tables_ready
    if _meta_lead_tables_ready:
        return
    with _table_init_locks["meta_lead"]:
        if _meta_lead_tables_ready:
            return

        db.execute(text("""CREATE TABLE IF NOT EXISTS meta_lead_events (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            event_id VARCHAR(120),
            page_id VARCHAR(120),
            form_id VARCHAR(120),
            form_name VARCHAR(255),
            leadgen_id VARCHAR(120),
            ad_id VARCHAR(120),
            campaign_id VARCHAR(120),
            adset_id VARCHAR(120),
            source VARCHAR(60) DEFAULT 'meta_lead_ads',
            form_fields_json TEXT NOT NULL DEFAULT '{}',
            payload_json TEXT NOT NULL DEFAULT '{}',
            contact_phone VARCHAR(60),
            contact_email VARCHAR(160),
            contact_name VARCHAR(180),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("CREATE TABLE IF NOT EXISTS meta_lead_replay_guard ("
            "id SERIAL PRIMARY KEY, replay_key VARCHAR(220) UNIQUE NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())"))
        db.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_lead_replay_guard_key ON meta_lead_replay_guard(replay_key)"))
        db.commit()
        _meta_lead_tables_ready = True


def _ensure_template_tables(db: Session) -> None:
    global _template_tables_ready
    if _template_tables_ready:
        return
    with _table_init_locks["template"]:
        if _template_tables_ready:
            return

        db.execute(text("""CREATE TABLE IF NOT EXISTS message_templates (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            name VARCHAR(120) NOT NULL,
            category VARCHAR(60) NOT NULL DEFAULT 'general',
            channel VARCHAR(30) NOT NULL DEFAULT 'whatsapp',
            content TEXT NOT NULL,
            variables_json TEXT NOT NULL DEFAULT '[]',
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_by INTEGER,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("""CREATE TABLE IF NOT EXISTS template_suggestions_logs (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            ticket_id INTEGER,
            contact_id INTEGER,
            query_text TEXT,
            suggested_template_id INTEGER,
            suggested_payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))
        db.commit()
        _template_tables_ready = True


def _ensure_crm_feature_tables(db: Session) -> None:
    global _crm_feature_tables_ready
    if _crm_feature_tables_ready:
        return
    with _table_init_locks["crm"]:
        if _crm_feature_tables_ready:
            return

        db.execute(text("""CREATE TABLE IF NOT EXISTS internal_notes (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            entity_type VARCHAR(20) NOT NULL,
            entity_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            mentions_json TEXT NOT NULL DEFAULT '[]',
            created_by INTEGER,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("""CREATE TABLE IF NOT EXISTS integration_errors (
            id SERIAL PRIMARY KEY,
            company_id INTEGER,
            source VARCHAR(30) NOT NULL,
            severity VARCHAR(20) NOT NULL DEFAULT 'medium',
            error_code VARCHAR(120),
            message TEXT NOT NULL,
            suggestion TEXT,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("""CREATE TABLE IF NOT EXISTS followup_sequences (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            ticket_id INTEGER,
            contact_id INTEGER,
            day_offset INTEGER NOT NULL,
            template_text TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
            scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
            executed_at TIMESTAMP WITH TIME ZONE,
            idempotency_key VARCHAR(180),
            sequence_group VARCHAR(180),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_company_idempotency ON followup_sequences(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL"))

        db.execute(text("""CREATE TABLE IF NOT EXISTS lead_score_events (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            contact_id INTEGER NOT NULL,
            previous_score INTEGER,
            new_score INTEGER NOT NULL,
            previous_status VARCHAR(30),
            new_status VARCHAR(30),
            reason VARCHAR(120) NOT NULL DEFAULT 'manual',
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_by INTEGER,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("CREATE INDEX IF NOT EXISTS idx_lead_score_events_company_contact ON lead_score_events(company_id, contact_id, id DESC)"))
        db.commit()
        _crm_feature_tables_ready = True


# ── Tool manifest ───────────────────────────────────────────────────

TOOL_MANIFEST = [
    {"name": "upsert_contact", "description": "Crea o actualiza un contacto por número", "requiredArgs": ["number"], "optionalArgs": ["name", "email", "businessType", "needs", "leadScore"]},
    {"name": "agendar_cita", "description": "Agenda una cita para un contacto", "requiredArgs": ["contactId", "startsAt"], "optionalArgs": ["durationMin", "ticketId", "serviceType", "notes"]},
    {"name": "reprogramar_cita", "description": "Reprograma una cita existente", "requiredArgs": ["appointmentId", "startsAt"], "optionalArgs": ["durationMin", "reason"]},
    {"name": "cancelar_cita", "description": "Cancela una cita existente", "requiredArgs": ["appointmentId"], "optionalArgs": ["reason"]},
    {"name": "consultar_conocimiento", "description": "Busca fragmentos relevantes en la base de conocimiento", "requiredArgs": ["query"], "optionalArgs": []},
    {"name": "actualizar_lead_score", "description": "Actualiza score y estado del lead", "requiredArgs": [], "optionalArgs": ["contactId", "ticketId", "leadScore", "inboundText", "text"]},
    {"name": "agregar_nota", "description": "Agrega una nota operativa asociada a ticket", "requiredArgs": ["ticketId", "note"], "optionalArgs": []},
]


# ── Schemas ─────────────────────────────────────────────────────────

class AgentCreate(BaseModel):
    name: str
    persona: str = ""
    language: str = "es"
    model: str = "gpt-4o-mini"
    temperature: float = 0.3
    maxTokens: int = 600
    isActive: bool = True
    welcomeMsg: str = ""
    offhoursMsg: str = ""
    farewellMsg: str = ""
    businessHoursJson: str = "{}"
    funnelStagesJson: str = '["Nuevo","Contactado","Calificado","Interesado"]'


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    persona: Optional[str] = None
    language: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    maxTokens: Optional[int] = None
    isActive: Optional[bool] = None
    welcomeMsg: Optional[str] = None
    offhoursMsg: Optional[str] = None
    farewellMsg: Optional[str] = None
    businessHoursJson: Optional[str] = None
    funnelStagesJson: Optional[str] = None


class KBDocumentCreate(BaseModel):
    title: str
    category: str = "faq"
    content: str = ""


class KBDocumentUpdate(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None
    content: Optional[str] = None


class TemplateCreate(BaseModel):
    name: str
    category: str = "general"
    channel: str = "whatsapp"
    content: str = ""
    variablesJson: str = "[]"
    isActive: bool = True


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    channel: Optional[str] = None
    content: Optional[str] = None
    variablesJson: Optional[str] = None
    isActive: Optional[bool] = None


class ToolExecuteRequest(BaseModel):
    tool: str
    args: dict[str, Any] = {}


class NoteCreate(BaseModel):
    entityType: str = "ticket"
    entityId: int
    content: str


class NoteUpdate(BaseModel):
    content: str


class RoutingRuleUpdate(BaseModel):
    rules: list[Any] = []


class FollowupScheduleRequest(BaseModel):
    ticketId: Optional[int] = None
    contactId: Optional[int] = None
    baseDate: Optional[str] = None
    sequenceGroup: Optional[str] = None
    idempotencyKey: Optional[str] = None


class LeadRecalculateScoreRequest(BaseModel):
    interactions: Optional[int] = None
    inactiveDays: Optional[int] = None
    source: Optional[str] = None
    tags: Optional[list[str]] = None
    reason: Optional[str] = "recalculate"


class LeadStatusRequest(BaseModel):
    status: str
    lossReason: str = ""


class MetaOAuthStartRequest(BaseModel):
    redirectAfter: str = "/settings"


class MetaOAuthTestSendRequest(BaseModel):
    to: str
    text: str = "Test exitoso desde Charlott OAuth + WhatsApp Cloud API"
    templateName: str = ""
    languageCode: str = "en"
    templateVariables: Optional[list[str]] = None
    idempotencyKey: Optional[str] = None


class IntegrationErrorLogRequest(BaseModel):
    source: str
    severity: str = "medium"
    errorCode: Optional[str] = None
    message: str
    suggestion: Optional[str] = None
    payload: dict[str, Any] = {}


# ── GET /api/ai/hardening/wa-cloud ──────────────────────────────────
@router.get("/hardening/wa-cloud")
def get_wa_hardening(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    failOnAlert: str = Query(""),
):
    require_admin(payload)
    # Placeholder hardening metrics - integrate with actual hardening services
    inbound_metrics = {"requests": 0, "blocked": 0, "alerts": []}
    outbound_metrics = {"sent": 0, "failed": 0, "alerts": []}
    meta_webhook_metrics = {"received": 0, "processed": 0, "alerts": []}

    pending_alerts = []
    pending_critical = sum(1 for a in pending_alerts if str(a.get("severity", "")).lower() == "critical")
    status = "critical" if pending_critical > 0 else "warn" if pending_alerts else "ok"
    status_code = 503 if failOnAlert.lower() in ("1", "true", "yes", "on") and pending_alerts else 200

    return {
        "ok": len(pending_alerts) == 0,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "hardening": {
            "status": status,
            "pendingAlertCount": len(pending_alerts),
            "failOnAlert": failOnAlert.lower() in ("1", "true", "yes", "on"),
            "pendingCriticalCount": pending_critical,
            "inbound": inbound_metrics,
            "outbound": outbound_metrics,
            "metaWebhook": meta_webhook_metrics,
        }
    }


# ── GET /api/ai/agents ───────────────────────────────────────────────
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


# ── POST /api/ai/agents ──────────────────────────────────────────────
@router.post("/agents", status_code=201)
def create_agent(
    body: AgentCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    row = db.execute(
        text("""INSERT INTO ai_agents
            (company_id, name, persona, language, model, temperature, max_tokens, is_active,
             welcome_msg, offhours_msg, farewell_msg, business_hours_json, funnel_stages_json, created_at, updated_at)
            VALUES (:companyId, :name, :persona, :language, :model, :temperature, :maxTokens,
                    :isActive, :welcomeMsg, :offhoursMsg, :farewellMsg, :businessHoursJson, :funnelStagesJson, NOW(), NOW())
            RETURNING *"""),
        {
            "companyId": company_id,
            "name": body.name,
            "persona": body.persona,
            "language": body.language,
            "model": body.model,
            "temperature": body.temperature,
            "maxTokens": body.maxTokens,
            "isActive": body.isActive,
            "welcomeMsg": body.welcomeMsg,
            "offhoursMsg": body.offhoursMsg,
            "farewellMsg": body.farewellMsg,
            "businessHoursJson": body.businessHoursJson,
            "funnelStagesJson": body.funnelStagesJson,
        },
    ).mappings().first()

    db.commit()
    return dict(row) if row else None


# ── PUT /api/ai/agents/{id} ─────────────────────────────────────────
@router.put("/agents/{agent_id}")
def update_agent(
    agent_id: int,
    body: AgentUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

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


# ── POST /api/ai/tickets/{ticketId}/toggle-bot ─────────────────────
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


# ── GET /api/ai/kb/documents ────────────────────────────────────────
@router.get("/kb/documents")
def list_kb_documents(
    q: str = Query(""),
    category: str = Query(""),
    status: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    where_clauses = ["d.company_id = :companyId"]
    params = {"companyId": company_id}

    if q:
        where_clauses.append("(LOWER(d.title) LIKE LOWER(:q) OR LOWER(d.content) LIKE LOWER(:q))")
        params["q"] = f"%{q}%"
    if category:
        where_clauses.append("d.category = :category")
        params["category"] = category
    if status:
        where_clauses.append("d.status = :status")
        params["status"] = status

    rows = db.execute(
        text(f"""SELECT d.id, d.title, d.category, d.status, d.source_type, d.content, d.created_at, d.updated_at,
                COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
         FROM kb_documents d
         WHERE {' AND '.join(where_clauses)}
         ORDER BY d.id DESC LIMIT 500"""),
        params,
    ).mappings().all()

    return [dict(row) for row in rows]


# ── POST /api/ai/kb/documents ───────────────────────────────────────
@router.post("/kb/documents", status_code=201)
def create_kb_document(
    body: KBDocumentCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    doc = db.execute(
        text("""INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
            VALUES (:companyId, :title, :category, 'manual', 'ready', :content, NOW(), NOW())
            RETURNING *"""),
        {"companyId": company_id, "title": body.title, "category": body.category, "content": body.content},
    ).mappings().first()

    # Chunk by paragraphs
    parts = [p.strip() for p in re.split(r"\n{2,}", body.content) if p.strip()][:200]
    for i, part in enumerate(parts):
        db.execute(
            text("""INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
                VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())"""),
            {"documentId": doc["id"], "chunkIndex": i, "chunkText": part, "tokenCount": max(1, math.floor(len(part) / 4))},
        )

    db.commit()
    return {"document": dict(doc), "chunksCreated": len(parts)}


# ── PUT /api/ai/kb/documents/{id} ───────────────────────────────────
@router.put("/kb/documents/{doc_id}")
def update_kb_document(
    doc_id: int,
    body: KBDocumentUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    existing = db.execute(
        text("SELECT * FROM kb_documents WHERE id = :id AND company_id = :companyId LIMIT 1"),
        {"id": doc_id, "companyId": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="Documento no encontrado")

    next_title = body.title if isinstance(body.title, str) else existing["title"]
    next_category = body.category if isinstance(body.category, str) else existing["category"]
    next_content = body.content if isinstance(body.content, str) else existing["content"]

    db.execute(
        text("UPDATE kb_documents SET title = :title, category = :category, content = :content, updated_at = NOW() WHERE id = :id AND company_id = :companyId"),
        {"id": doc_id, "companyId": company_id, "title": next_title, "category": next_category, "content": next_content},
    )

    db.execute(text("DELETE FROM kb_chunks WHERE document_id = :documentId"), {"documentId": doc_id})

    parts = [p.strip() for p in re.split(r"\n{2,}", next_content) if p.strip()][:200]
    for i, part in enumerate(parts):
        db.execute(
            text("""INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
                VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())"""),
            {"documentId": doc_id, "chunkIndex": i, "chunkText": part, "tokenCount": max(1, math.floor(len(part) / 4))},
        )

    updated = db.execute(
        text("""SELECT d.id, d.title, d.category, d.status, d.source_type, d.created_at, d.updated_at,
                COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
         FROM kb_documents d WHERE d.id = :id AND d.company_id = :companyId LIMIT 1"""),
        {"id": doc_id, "companyId": company_id},
    ).mappings().first()

    db.commit()
    return {"ok": True, "document": dict(updated) if updated else None, "chunksCreated": len(parts)}


# ── DELETE /api/ai/kb/documents/{id} ───────────────────────────────
@router.delete("/kb/documents/{doc_id}")
def delete_kb_document(
    doc_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    existing = db.execute(
        text("SELECT id FROM kb_documents WHERE id = :id AND company_id = :companyId LIMIT 1"),
        {"id": doc_id, "companyId": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="Documento no encontrado")

    db.execute(text("DELETE FROM kb_chunks WHERE document_id = :documentId"), {"documentId": doc_id})
    db.execute(text("DELETE FROM kb_documents WHERE id = :id AND company_id = :companyId"), {"id": doc_id, "companyId": company_id})
    db.commit()

    return {"ok": True, "deletedId": doc_id}


# ── GET /api/ai/kb/stats ─────────────────────────────────────────────
@router.get("/kb/stats")
def get_kb_stats(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    row = db.execute(
        text("""SELECT COUNT(*)::int AS total,
                    SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END)::int AS synced,
                    SUM(CASE WHEN status <> 'ready' THEN 1 ELSE 0 END)::int AS pending,
                    COUNT(DISTINCT category)::int AS categories
             FROM kb_documents WHERE company_id = :companyId"""),
        {"companyId": company_id},
    ).mappings().first()

    return dict(row) if row else {"total": 0, "synced": 0, "pending": 0, "categories": 0}


# ── POST /api/ai/rag/search ─────────────────────────────────────────
@router.post("/rag/search")
def rag_search(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    query = str(body.get("query", ""))
    limit = min(100, max(1, int(body.get("limit", 5))))

    rows = db.execute(
        text("""SELECT c.id, c.document_id, c.chunk_text, d.title, d.category,
                        (CASE WHEN POSITION(LOWER(:query) IN LOWER(c.chunk_text)) > 0 THEN 0.95 ELSE 0.50 END) AS score
                 FROM kb_chunks c
                 JOIN kb_documents d ON d.id = c.document_id
                 WHERE d.company_id = :companyId
                   AND (LOWER(c.chunk_text) LIKE LOWER(:qLike) OR LOWER(d.title) LIKE LOWER(:qLike))
                 ORDER BY score DESC, c.id DESC
                 LIMIT :limit"""),
        {"companyId": company_id, "query": query, "qLike": f"%{query}%", "limit": limit},
    ).mappings().all()

    # Log search
    db.execute(
        text("""INSERT INTO kb_search_logs (company_id, query, top_k, results_json, created_at, updated_at)
            VALUES (:companyId, :query, :topK, :resultsJson, NOW(), NOW())"""),
        {"companyId": company_id, "query": query, "topK": limit, "resultsJson": json.dumps([dict(r) for r in rows])},
    )
    db.commit()

    return [dict(row) for row in rows]


# ── Schemas for Orchestrator ─────────────────────────────────────────

class OrchestrateRequest(BaseModel):
    message: str
    conversation_history: list[dict[str, Any]] = []
    conversation_id: Optional[int] = None
    contact_id: Optional[int] = None
    conversation_state: str = "new"
    use_orchestrator: bool = True


# ── POST /api/ai/orchestrate ─────────────────────────────────────────
@router.post("/orchestrate")
async def orchestrate(
    body: OrchestrateRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """
    Full orchestrator pipeline: intent detection, slot extraction,
    hybrid RAG, tool calling, guardrails, state machine, trace persistence.
    """
    company_id = payload.get("companyId")
    
    from app.services.conversation_orchestrator import orchestrate_reply

    result = await orchestrate_reply(
        text=body.message,
        conversation_history=body.conversation_history,
        company_id=company_id,
        conversation_id=body.conversation_id,
        contact_id=body.contact_id,
        conversation_state=body.conversation_state,
    )

    return result


# ── GET /api/ai/funnel/stats ─────────────────────────────────────────
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


# ── GET /api/ai/appointments ─────────────────────────────────────────
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


# ── GET /api/ai/reports/attribution ─────────────────────────────────
@router.get("/reports/attribution")
def get_reports_attribution(
    from_date: str = Query(""),
    to_date: str = Query(""),
    source: str = Query(""),
    campaign: str = Query(""),
    form: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_lead_tables(db)
    company_id = payload.get("companyId")

    where_clauses = ["company_id = :companyId", "(COALESCE(leadgen_id,'') <> '' AND (NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), '') IS NOT NULL OR COALESCE(contact_email,'') <> '' OR COALESCE(contact_name,'') <> '' OR COALESCE(form_fields_json,'') NOT IN ('','{}','[]')))"]
    params = {"companyId": company_id}

    if from_date:
        where_clauses.append("created_at >= :fromDate")
        params["fromDate"] = from_date
    if to_date:
        where_clauses.append("created_at < (:toDate::date + INTERVAL '1 day')")
        params["toDate"] = to_date
    if source:
        where_clauses.append("source = :source")
        params["source"] = source
    if campaign:
        where_clauses.append("LOWER(COALESCE(campaign_id,'')) LIKE LOWER(:campaign)")
        params["campaign"] = f"%{campaign}%"
    if form:
        where_clauses.append("(LOWER(COALESCE(form_name,'')) LIKE LOWER(:form) OR LOWER(COALESCE(form_id,'')) LIKE LOWER(:form))")
        params["form"] = f"%{form}%"

    base_where = " AND ".join(where_clauses)

    # Summary
    summary = db.execute(
        text(f"""SELECT COUNT(*)::int AS total_leads, COUNT(DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), ''))::int AS unique_phones,
                    COUNT(DISTINCT NULLIF(COALESCE(campaign_id,''), ''))::int AS campaigns,
                    COUNT(DISTINCT NULLIF(COALESCE(form_id,''), ''))::int AS forms
             FROM meta_lead_events WHERE {base_where}"""),
        params,
    ).mappings().first()

    by_source = db.execute(
        text(f"""SELECT COALESCE(NULLIF(source,''), 'unknown') AS source, COUNT(*)::int AS leads
             FROM meta_lead_events WHERE {base_where}
             GROUP BY COALESCE(NULLIF(source,''), 'unknown') ORDER BY leads DESC LIMIT 20"""),
        params,
    ).mappings().all()

    by_campaign = db.execute(
        text(f"""SELECT COALESCE(NULLIF(campaign_id,''), 'unknown') AS campaign, COUNT(*)::int AS leads
             FROM meta_lead_events WHERE {base_where}
             GROUP BY COALESCE(NULLIF(campaign_id,''), 'unknown') ORDER BY leads DESC LIMIT 30"""),
        params,
    ).mappings().all()

    timeline = db.execute(
        text(f"""SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS leads
             FROM meta_lead_events WHERE {base_where}
             GROUP BY created_at::date ORDER BY day DESC LIMIT 31"""),
        params,
    ).mappings().all()

    return {
        "summary": dict(summary) if summary else {"total_leads": 0, "unique_phones": 0, "campaigns": 0, "forms": 0},
        "bySource": [dict(r) for r in by_source],
        "byCampaign": [dict(r) for r in by_campaign],
        "timeline": [dict(r) for r in timeline],
    }


# ── Templates ────────────────────────────────────────────────────────

@router.get("/templates")
def list_templates(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_template_tables(db)
    company_id = payload.get("companyId")
    rows = db.execute(
        text("SELECT * FROM message_templates WHERE company_id = :companyId ORDER BY id DESC"),
        {"companyId": company_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/templates", status_code=201)
def create_template(
    body: TemplateCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_template_tables(db)
    company_id = payload.get("companyId")
    user_id = payload.get("id")

    vars_json = body.variablesJson if isinstance(body.variablesJson, str) else json.dumps(body.variablesJson or [])

    row = db.execute(
        text("""INSERT INTO message_templates (company_id, name, category, channel, content, variables_json, is_active, created_by, created_at, updated_at)
            VALUES (:companyId, :name, :category, :channel, :content, :variablesJson, :isActive, :userId, NOW(), NOW())
            RETURNING *"""),
        {"companyId": company_id, "name": body.name, "category": body.category, "channel": body.channel,
         "content": body.content, "variablesJson": vars_json, "isActive": body.isActive, "userId": user_id},
    ).mappings().first()

    db.commit()
    return dict(row) if row else None


@router.put("/templates/{template_id}")
def update_template(
    template_id: int,
    body: TemplateUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_template_tables(db)
    company_id = payload.get("companyId")

    updates = []
    params = {"id": template_id, "companyId": company_id}

    for field, db_field, value in [
        ("name", "name", body.name),
        ("category", "category", body.category),
        ("channel", "channel", body.channel),
        ("content", "content", body.content),
        ("isActive", "is_active", body.isActive),
    ]:
        if value is not None:
            updates.append(f"{db_field} = :{field}")
            params[field] = value

    if body.variablesJson is not None:
        vars_json = body.variablesJson if isinstance(body.variablesJson, str) else json.dumps(body.variablesJson)
        updates.append("variables_json = :variablesJson")
        params["variablesJson"] = vars_json

    if updates:
        updates.append("updated_at = NOW()")
        db.execute(
            text(f"UPDATE message_templates SET {', '.join(updates)} WHERE id = :id AND company_id = :companyId"),
            params,
        )

    tmpl = db.execute(
        text("SELECT * FROM message_templates WHERE id = :id AND company_id = :companyId"),
        {"id": template_id, "companyId": company_id},
    ).mappings().first()

    db.commit()
    return dict(tmpl) if tmpl else None


@router.delete("/templates/{template_id}")
def delete_template(
    template_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_template_tables(db)
    company_id = payload.get("companyId")

    db.execute(
        text("DELETE FROM message_templates WHERE id = :id AND company_id = :companyId"),
        {"id": template_id, "companyId": company_id},
    )
    db.commit()
    return {"ok": True, "deletedId": template_id}


@router.post("/templates/suggest")
def suggest_template(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_template_tables(db)
    company_id = payload.get("companyId")
    ticket_id = body.get("ticketId")
    contact_id = body.get("contactId")
    query_text = str(body.get("query", ""))

    row = db.execute(
        text("SELECT * FROM message_templates WHERE company_id = :companyId AND is_active = true ORDER BY id DESC LIMIT 1"),
        {"companyId": company_id},
    ).mappings().first()

    suggestion = {"templateId": row["id"], "content": row["content"], "variables": json.loads(row["variables_json"])} if row else None

    db.execute(
        text("""INSERT INTO template_suggestions_logs (company_id, ticket_id, contact_id, query_text, suggested_template_id, suggested_payload_json, created_at)
            VALUES (:companyId, :ticketId, :contactId, :queryText, :templateId, :payload, NOW())"""),
        {"companyId": company_id, "ticketId": ticket_id, "contactId": contact_id, "queryText": query_text,
         "templateId": suggestion["templateId"] if suggestion else None, "payload": json.dumps(suggestion or {})},
    )
    db.commit()

    return {"suggestion": suggestion}


@router.post("/templates/send")
def send_template(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
):
    return {"ok": True, "queued": True, "templateId": int(body.get("templateId") or 0), "ticketId": int(body.get("ticketId") or 0), "contactId": int(body.get("contactId") or 0), "payload": body.get("payload", {}), "note": "Scaffold: conectar envío real con canal WhatsApp/Cloud"}


@router.post("/templates/preview")
def preview_template(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
):
    template = str(body.get("template") or body.get("content") or "")
    variables = body.get("variables", {})
    missing = list(set(re.findall(r"{{\s*([a-zA-Z0-9_.-]+)\s*}}", template)) - set(variables.keys()))
    return {"rendered": _render_template(template, variables), "missingVariables": missing}


# ── Meta OAuth ───────────────────────────────────────────────────────

def _sign_meta_state(payload: str) -> str:
    secret = settings.meta_app_secret or settings.jwt_secret
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]


def _get_meta_oauth_config(request: Request = None) -> dict[str, str]:
    runtime = _get_runtime_settings()
    client_id = str(settings.meta_app_secret or runtime.get("metaLeadAdsAppId", "")).strip()
    client_secret = str(settings.meta_app_secret or runtime.get("metaLeadAdsAppSecret", "")).strip()
    redirect_uri = str(runtime.get("metaOauthRedirectUri", f"https://login.charlott.ai/api/ai/meta/oauth/callback")).strip()
    return {"clientId": client_id, "clientSecret": client_secret, "redirectUri": redirect_uri}


@router.get("/meta/oauth/start")
def meta_oauth_start(
    request: Request,
    redirectAfter: str = Query("/settings"),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_oauth_tables(db)
    oauth = _get_meta_oauth_config(request)
    if not oauth["clientId"] or not oauth["redirectUri"]:
        raise HTTPException(status_code=400, detail="missing_meta_oauth_config")

    company_id = int(payload.get("companyId") or 0)
    user_id = int(payload.get("id") or 0) or None

    import secrets
    nonce = secrets.token_hex(16)
    state_payload = json.dumps({"companyId": company_id, "userId": user_id, "nonce": nonce, "ts": datetime.utcnow().timestamp()})
    payload_b64 = __import__("base64").urlsafe_b64encode(state_payload.encode()).decode().rstrip("=")
    sig = _sign_meta_state(payload_b64)
    state = f"{payload_b64}.{sig}"

    db.execute(
        text("""INSERT INTO meta_oauth_states (company_id, user_id, nonce, state_hash, redirect_after, status, expires_at)
            VALUES (:companyId, :userId, :nonce, :stateHash, :redirectAfter, 'pending', NOW() + INTERVAL '10 minutes')"""),
        {"companyId": company_id, "userId": user_id, "nonce": nonce,
         "stateHash": hashlib.sha256(state.encode()).hexdigest(), "redirectAfter": redirectAfter[:650]},
    )
    db.commit()

    scope = "whatsapp_business_management,whatsapp_business_messaging,business_management"
    from urllib.parse import urlencode
    oauth_url = f"https://www.facebook.com/{GRAPH_API_VERSION}/dialog/oauth?" + urlencode({
        "client_id": oauth["clientId"],
        "redirect_uri": oauth["redirectUri"],
        "state": state,
        "response_type": "code",
        "scope": scope,
    })

    return {"ok": True, "oauthUrl": oauth_url, "statePreview": f"{state[:10]}..."}


@router.get("/meta/oauth/callback")
def meta_oauth_callback(
    request: Request,
    error: str = Query(""),
    error_description: str = Query(""),
    code: str = Query(""),
    state: str = Query(""),
    db: Session = Depends(get_db),
):
    _ensure_meta_oauth_tables(db)

    if error:
        raise HTTPException(status_code=400, detail=f"Meta OAuth error: {error_description or error}")

    if not code or not state or "." not in state:
        raise HTTPException(status_code=400, detail="Missing code/state")

    import base64
    parts = state.split(".", 1)
    payload_b64, sig = parts[0], parts[1]
    if _sign_meta_state(payload_b64) != sig:
        raise HTTPException(status_code=400, detail="Invalid state signature")

    decoded = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)).decode())
    company_id = int(decoded.get("companyId") or 0)
    state_hash = hashlib.sha256(state.encode()).hexdigest()

    state_row = db.execute(
        text("""SELECT * FROM meta_oauth_states WHERE state_hash = :stateHash AND company_id = :companyId AND status = 'pending' AND expires_at > NOW() ORDER BY id DESC LIMIT 1"""),
        {"stateHash": state_hash, "companyId": company_id},
    ).mappings().first()

    if not state_row:
        raise HTTPException(status_code=400, detail="State expired/used")

    oauth = _get_meta_oauth_config(request)
    if not oauth["clientId"] or not oauth["clientSecret"] or not oauth["redirectUri"]:
        raise HTTPException(status_code=400, detail="Missing OAuth config on server")

    from urllib.parse import urlencode
    token_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/oauth/access_token?" + urlencode({
        "client_id": oauth["clientId"],
        "client_secret": oauth["clientSecret"],
        "redirect_uri": oauth["redirectUri"],
        "code": code,
    })

    import httpx
    token_resp = httpx.get(token_url, timeout=10)
    token_data = token_resp.json() if token_resp.status_code == 200 else {}
    if not token_resp.ok or not token_data.get("access_token"):
        raise HTTPException(status_code=400, detail=f"Token exchange failed: {token_data.get('error', {}).get('message', token_resp.status_code)}")

    access_token = str(token_data["access_token"])

    # Get business info
    me_resp = httpx.get(f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/businesses?fields=id,name&access_token={access_token}", timeout=10)
    me_businesses = me_resp.json() if me_resp.ok else {}
    business_id = str(me_businesses.get("data", [{}])[0].get("id", ""))

    waba_id, phone_number_id, phone_display = "", "", ""
    if business_id:
        waba_resp = httpx.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{business_id}/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number}&access_token={access_token}",
            timeout=10,
        )
        waba_data = waba_resp.json() if waba_resp.ok else {}
        waba_id = str(waba_data.get("data", [{}])[0].get("id", ""))
        phone_number_id = str(waba_data.get("data", [{}])[0].get("phone_numbers", {}).get("data", [{}])[0].get("id", ""))
        phone_display = str(waba_data.get("data", [{}])[0].get("phone_numbers", {}).get("data", [{}])[0].get("display_phone_number", ""))

    expires_at = datetime.utcnow() + __import__("datetime").timedelta(seconds=int(token_data.get("expires_in", 0))) if token_data.get("expires_in") else None

    db.execute(
        text("""INSERT INTO meta_connections (company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, access_token, token_type, token_expires_at, scopes_json, status, created_at, updated_at)
            VALUES (:companyId, :businessId, :wabaId, :phoneNumberId, :phoneDisplay, :accessToken, :tokenType, :expiresAt, :scopesJson, 'connected', NOW(), NOW())"""),
        {"companyId": company_id, "businessId": business_id or None, "wabaId": waba_id or None, "phoneNumberId": phone_number_id or None,
         "phoneDisplay": phone_display or None, "accessToken": access_token, "tokenType": str(token_data.get("token_type", "bearer")),
         "expiresAt": expires_at, "scopesJson": json.dumps(token_data.get("scope", []))},
    )

    db.execute(text("UPDATE meta_oauth_states SET status = 'used', used_at = NOW() WHERE id = :id"), {"id": state_row["id"]})
    db.commit()

    redirect_after = str(state_row.get("redirect_after") or "/settings")
    separator = "&" if "?" in redirect_after else "?"
    return {"redirect": f"{redirect_after}{separator}meta_oauth=ok"}


@router.get("/meta/oauth/status")
def meta_oauth_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_oauth_tables(db)
    company_id = payload.get("companyId")
    row = db.execute(
        text("""SELECT id, company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, token_expires_at, status, updated_at
             FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1"""),
        {"companyId": company_id},
    ).mappings().first()
    return dict(row) if row else {"connected": False}


@router.post("/meta/oauth/test-send")
def meta_oauth_test_send(
    body: MetaOAuthTestSendRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    x_idempotency_key: Optional[str] = Header(None),
    idempotency_key: Optional[str] = Header(None),
):
    _ensure_meta_oauth_tables(db)
    company_id = payload.get("companyId")
    to = re.sub(r"\D", "", body.to)
    if not to:
        raise HTTPException(status_code=400, detail="missing_to")

    conn = db.execute(
        text("SELECT * FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1"),
        {"companyId": company_id},
    ).mappings().first()

    if not conn or not conn.get("access_token") or not conn.get("phone_number_id"):
        raise HTTPException(status_code=400, detail="missing_connection_or_phone")

    effective_key = x_idempotency_key or idempotency_key or body.idempotencyKey

    import httpx
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {conn['access_token']}"}
    if effective_key:
        headers["Idempotency-Key"] = effective_key

    if body.templateName:
        payload_json = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "template",
            "template": {
                "name": body.templateName,
                "language": {"code": body.languageCode or "en"},
                **({"components": [{"type": "body", "parameters": [{"type": "text", "text": str(v)} for v in (body.templateVariables or [])]}]} if body.templateVariables else {}),
            },
        }
    else:
        payload_json = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": body.text}}

    resp = httpx.post(f"https://graph.facebook.com/{GRAPH_API_VERSION}/{conn['phone_number_id']}/messages", headers=headers, json=payload_json, timeout=30)
    data = resp.json() if resp.ok else {}
    if not resp.ok:
        raise HTTPException(status_code=400, detail=data.get("error", {}).get("message", "Cloud send failed"))

    message_id = str(data.get("messages", [{}])[0].get("id", f"meta-{datetime.utcnow().timestamp()}"))
    return {"ok": True, "mode": "template" if body.templateName else "text", "messageId": message_id, "to": to, "phoneNumberId": conn["phone_number_id"], "templateName": body.templateName, "languageCode": body.languageCode, "idempotencyKeyUsed": bool(effective_key)}


# ── Meta Leads Webhook ───────────────────────────────────────────────

@router.get("/meta-leads/webhook")
def meta_leads_webhook_verify(
    hub_mode: str = Query(""),
    hub_verify_token: str = Query(""),
    hub_challenge: str = Query(""),
):
    s = _get_runtime_settings()
    if hub_mode == "subscribe" and hub_verify_token and hub_verify_token == str(s.get("metaLeadAdsWebhookVerifyToken", "")):
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(content=hub_challenge or "ok", status_code=200)
    raise HTTPException(status_code=403, detail="verification_failed")


@router.post("/meta-leads/webhook")
def meta_leads_webhook(
    request: Request,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_lead_tables(db)
    body = request.state._body if hasattr(request.state, "_body") else request._body

    # Process events (simplified - full implementation would handle signature verification)
    events = []
    if isinstance(body, dict) and body.get("object") == "page" and isinstance(body.get("entry"), list):
        for entry in body["entry"]:
            page_id = str(entry.get("id", "")).strip()
            for change in entry.get("changes", []):
                value = change.get("value", {})
                leadgen_id = str(value.get("leadgen_id") or value.get("lead", {}).get("id", "")).strip()
                if leadgen_id:
                    events.append({
                        "companyId": body.get("companyId", 1),
                        "page_id": page_id,
                        "form_id": str(value.get("form_id") or "").strip(),
                        "leadgen_id": leadgen_id,
                        "ad_id": str(value.get("ad_id", "")).strip(),
                        "campaign_id": str(value.get("campaign_id", "")).strip(),
                    })

    results = []
    for ev in events:
        results.append({"ok": True, "ingested": True, "outreach": False})

    return {"ok": True, "ingested": any(r.get("ingested") for r in results), "events": len(results), "results": results}


@router.get("/meta-leads/context/{phone}")
def meta_leads_context(
    phone: str,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_lead_tables(db)
    company_id = payload.get("companyId")
    clean_phone = re.sub(r"\D", "", phone)
    row = db.execute(
        text("""SELECT id, form_id, form_name, campaign_id, ad_id, contact_name, contact_email, form_fields_json, created_at
             FROM meta_lead_events
             WHERE company_id = :companyId AND REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g') = :phone
             ORDER BY id DESC LIMIT 1"""),
        {"companyId": company_id, "phone": clean_phone},
    ).mappings().first()
    return dict(row) if row else None


# ── Tools ────────────────────────────────────────────────────────────

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


# ── Routing ───────────────────────────────────────────────────────────

@router.get("/routing/rules")
def get_routing_rules(payload: dict = Depends(get_current_user_payload)):
    runtime = _get_runtime_settings()
    rules = []
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


@router.post("/routing/resolve")
def resolve_routing(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
):
    runtime = _get_runtime_settings()
    rules = []
    try:
        rules = json.loads(runtime.get("routingRulesJson", "[]"))
    except Exception:
        rules = []

    source = str(body.get("source") or "").lower()
    tags = [str(t).lower() for t in (body.get("tags") or [])]
    channel = str(body.get("channel") or "").lower()
    priority = float(body.get("priority") or 0)

    match = None
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
        match = r
        break

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
    rules = []
    try:
        rules = json.loads(runtime.get("routingRulesJson", "[]"))
    except Exception:
        rules = []

    source = str(body.get("source") or "").lower()
    tags = [str(t).lower() for t in (body.get("tags") or [])]
    channel = str(body.get("channel") or "").lower()
    priority = float(body.get("priority") or 0)
    dry_run = str(body.get("dryRun") or "") == "1"

    match = None
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
        match = r
        break

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


# ── SLA ──────────────────────────────────────────────────────────────

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
    should_auto_assign = auto_assign == "1" or runtime.get("slaAutoReassign")

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


# ── Notes ────────────────────────────────────────────────────────────

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
        {"companyId": company_id, "entityType": body.entityType, "entityId": body.entityId, "content": body.content, "mentionsJson": json.dumps(mentions), "createdBy": user_id},
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

    created, skipped = [], []
    for day in days:
        scheduled_at = base_date + __import__("datetime").timedelta(days=day)
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


# Sequences aliases
@router.get("/sequences")
def list_sequences(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    return list_followups(payload, db)


@router.post("/sequences/schedule")
def schedule_sequences(body: FollowupScheduleRequest, payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    return schedule_followups(body, payload, db)


@router.post("/sequences/run-due")
def run_due_sequences(body: dict[str, Any] = {}, payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    return run_due_followups(body, payload, db)


# ── Dedupe ────────────────────────────────────────────────────────────

@router.get("/dedupe/candidates")
def get_dedupe_candidates(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    rows = db.execute(
        text("""WITH by_phone AS (
            SELECT 'phone'::text AS dedupe_key_type,
                   REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g') AS dedupe_key,
                   ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
                   COUNT(*)::int AS qty
            FROM contacts c
            WHERE c."companyId" = :companyId AND REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g') <> ''
            GROUP BY REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g')
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

    # Merge
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

    # Count interactions
    interactions_result = db.execute(text('SELECT COUNT(*)::int AS qty FROM messages WHERE "contactId" = :contactId'), {"contactId": contact_id}).mappings().first()
    interactions = body.interactions if body.interactions is not None else int(interactions_result["qty"]) if interactions_result else 0

    # Inactive days
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


# ── Tokko Audit ──────────────────────────────────────────────────────

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


# ── Recapture ────────────────────────────────────────────────────────

@router.post("/recapture/run-now")
def run_recapture(
    payload: dict = Depends(get_current_user_payload),
):
    # Placeholder - integrate with CheckInactiveContactsService
    return {"ok": True, "message": "recapture scan executed"}


# ── Integration Errors ───────────────────────────────────────────────

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


# ── Ticket Decisions ─────────────────────────────────────────────────

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
