"""Shared helpers, schemas, and table-init logic for ai_routes sub-modules."""
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

# ── Constants ────────────────────────────────────────────────────────

GRAPH_API_VERSION = "v21.0"

_SETTINGS_FILE = Path(__file__).parent.parent.parent.parent / "runtime-settings.json"

TOOL_MANIFEST = [
    {"name": "upsert_contact", "description": "Crea o actualiza un contacto por número", "requiredArgs": ["number"], "optionalArgs": ["name", "email", "businessType", "needs", "leadScore"]},
    {"name": "agendar_cita", "description": "Agenda una cita para un contacto", "requiredArgs": ["contactId", "startsAt"], "optionalArgs": ["durationMin", "ticketId", "serviceType", "notes"]},
    {"name": "reprogramar_cita", "description": "Reprograma una cita existente", "requiredArgs": ["appointmentId", "startsAt"], "optionalArgs": ["durationMin", "reason"]},
    {"name": "cancelar_cita", "description": "Cancela una cita existente", "requiredArgs": ["appointmentId"], "optionalArgs": ["reason"]},
    {"name": "consultar_conocimiento", "description": "Busca fragmentos relevantes en la base de conocimiento", "requiredArgs": ["query"], "optionalArgs": []},
    {"name": "actualizar_lead_score", "description": "Actualiza score y estado del lead", "requiredArgs": [], "optionalArgs": ["contactId", "ticketId", "leadScore", "inboundText", "text"]},
    {"name": "agregar_nota", "description": "Agrega una nota operativa asociada a ticket", "requiredArgs": ["ticketId", "note"], "optionalArgs": []},
]

# ── Runtime settings ─────────────────────────────────────────────────

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


# ── Lead scoring helpers ─────────────────────────────────────────────

def _score_from_text(txt: str, current: int = 0) -> int:
    score = current
    if re.search(r"comprar|contratar|precio|plan|cotiz|demo", txt, re.IGNORECASE):
        score = max(score, 65)
    if re.search(r"urgente|hoy|ahora|ya", txt, re.IGNORECASE):
        score = max(score, 78)
    if re.search(r"presupuesto|interesa|quiero", txt, re.IGNORECASE):
        score = max(score, 72)
    if re.search(r"gracias|resuelto|listo", txt, re.IGNORECASE):
        score = max(score, 45)
    return min(100, score)


def _infer_lead_status_by_signals(txt: str, lead_score: int, current_status: str = "") -> str:
    t = txt.lower()
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


def _parse_mentions(txt: str) -> list[str]:
    return list(set(re.findall(r"@([a-zA-Z0-9_.-]{2,40})", txt)))


def _render_template(template: str, variables: dict[str, Any]) -> str:
    return re.sub(r"{{\s*([a-zA-Z0-9_.-]+)\s*}}", lambda m: str(variables.get(m.group(1), "")), template)


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


# ── Table initialization (thread-safe) ───────────────────────────────

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
            page_id VARCHAR(120),
            access_token TEXT NOT NULL,
            token_type VARCHAR(40),
            token_expires_at TIMESTAMP WITH TIME ZONE,
            scopes_json TEXT NOT NULL DEFAULT '[]',
            webhook_verified_at TIMESTAMP WITH TIME ZONE,
            status VARCHAR(40) NOT NULL DEFAULT 'connected',
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )"""))

        db.execute(text("ALTER TABLE meta_connections ADD COLUMN IF NOT EXISTS page_id VARCHAR(120)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS idx_meta_connections_company ON meta_connections(company_id, id DESC)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS idx_meta_connections_page ON meta_connections(company_id, page_id)"))
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


# ── Pydantic schemas ─────────────────────────────────────────────────

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
    templateId: Optional[int] = None
    templateVarsJson: Optional[str] = None


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


class OrchestrateRequest(BaseModel):
    message: str
    conversation_history: list[dict[str, Any]] = []
    conversation_id: Optional[int] = None
    contact_id: Optional[int] = None
    conversation_state: str = "new"
    use_orchestrator: bool = True
