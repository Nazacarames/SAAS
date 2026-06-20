"""
Knowledge Base - Lee desde kb_documents y ai_agents en la base de datos
"""
import json
from typing import Dict, Optional, List
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.core.db import get_db


# ==================== AI AGENT CONFIG ====================

def get_ai_agent_config(company_id: int = None) -> Dict:
    if company_id is None or int(company_id) <= 0:
        raise ValueError("company_id is required (multi-tenant safety)")
    """Get AI agent configuration from database"""
    try:
        db_gen = get_db()
        db = next(db_gen)
        row = db.execute(
            text("""
                SELECT name, persona, model, temperature, max_tokens,
                       welcome_msg, offhours_msg, farewell_msg,
                       business_hours_json, funnel_stages_json,
                       base_model, ft_system_prompt, ai_config_json,
                       country, zone_keywords, budget_floor_rent, budget_floor_sale, brand_name
                FROM ai_agents
                WHERE company_id = :company_id AND is_active = true
                ORDER BY id DESC
                LIMIT 1
            """),
            {"company_id": company_id}
        ).mappings().first()

        try:
            next(db_gen)
        except StopIteration:
            pass

        if not row:
            return _default_ai_agent()

        _ai_cfg = {}
        try:
            _ai_cfg = json.loads(row["ai_config_json"]) if row.get("ai_config_json") else {}
        except Exception:
            pass

        return {
            "name": row["name"] or "Asesor Virtual",
            "persona": row["persona"] or "",
            "model": row["model"] or "gpt-4o-mini",
            "temperature": float(row["temperature"]) if row["temperature"] else 0.3,
            "max_tokens": row["max_tokens"] or 600,
            "welcome_msg": row["welcome_msg"] or "",
            "offhours_msg": row["offhours_msg"] or "",
            "farewell_msg": row["farewell_msg"] or "",
            "business_hours": json.loads(row["business_hours_json"]) if row["business_hours_json"] else {},
            "funnel_stages": json.loads(row["funnel_stages_json"]) if row["funnel_stages_json"] else [],
            "base_model": row["base_model"] or "gpt-4o-mini",
            "ft_system_prompt": row["ft_system_prompt"] or "",
            "search_wait_msg": _ai_cfg.get("search_wait_msg", ""),
            "country": (row.get("country") or "AR"),
            "zone_keywords": (row.get("zone_keywords") or []),
            "budget_floor_rent": row.get("budget_floor_rent"),
            "budget_floor_sale": row.get("budget_floor_sale"),
            "brand_name": (row.get("brand_name") or ""),
        }
    except Exception as e:
        print(f"Error loading AI agent config: {e}")
        return _default_ai_agent()


def _default_ai_agent() -> Dict:
    """Default AI agent config when DB unavailable"""
    return {
        "name": "Asesor Virtual",
        "persona": "",
        "model": "gpt-4o-mini",
        "temperature": 0.3,
        "max_tokens": 600,
        "welcome_msg": "¡Hola! ¿En qué puedo ayudarte?",
        "offhours_msg": "¡Hola! En este momento no estamos disponibles.",
        "farewell_msg": "¡Hasta luego!",
        "business_hours": {},
        "funnel_stages": [],
    }


# ==================== KB DOCUMENTS ====================

def get_kb_documents(company_id: int = None, category: str = None) -> List[Dict]:
    if company_id is None or int(company_id) <= 0:
        raise ValueError("company_id is required (multi-tenant safety)")
    """Get ALL KB documents for a company (sin filtro)"""
    try:
        db_gen = get_db()
        db = next(db_gen)

        if category:
            rows = db.execute(
                text("""
                    SELECT title, category, content
                    FROM kb_documents
                    WHERE company_id = :company_id AND status IN ('active', 'ready') AND category = :category
                    ORDER BY id
                """),
                {"company_id": company_id, "category": category}
            ).mappings().all()
        else:
            rows = db.execute(
                text("""
                    SELECT title, category, content
                    FROM kb_documents
                    WHERE company_id = :company_id AND status IN ('active', 'ready')
                    ORDER BY id
                """),
                {"company_id": company_id}
            ).mappings().all()

        try:
            next(db_gen)
        except StopIteration:
            pass

        return [{"title": r["title"], "category": r["category"], "content": r["content"] or ""} for r in rows]
    except Exception as e:
        print(f"Error loading KB documents: {e}")
        return []


# ==================== COMPANY PROFILE ====================

# Neutral fallback — never expose real company data as defaults.
# All actual data must come from the `companies` / `ai_agents` DB tables per company_id.
COMPANY_PROFILE = {
    "name": "Empresa",
    "services": [],
    "description": "",
    "email": "",
    "whatsapp_phone": "",
    "hours": "",
    "hours_human": "",
    "address": None,
    "phone": None
}

SOCIAL_MEDIA = {}


def get_company_info() -> Dict:
    return COMPANY_PROFILE
