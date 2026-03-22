"""
Knowledge Base - Lee desde kb_documents y ai_agents en la base de datos
"""
import json
from typing import Dict, Optional, List
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.core.db import get_db


# ==================== AI AGENT CONFIG ====================

def get_ai_agent_config(company_id: int = 1) -> Dict:
    """Get AI agent configuration from database"""
    try:
        db_gen = get_db()
        db = next(db_gen)
        row = db.execute(
            text("""
                SELECT name, persona, model, temperature, max_tokens,
                       welcome_msg, offhours_msg, farewell_msg,
                       business_hours_json, funnel_stages_json
                FROM ai_agents
                WHERE company_id = :company_id AND is_active = true
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

def get_kb_documents(company_id: int = 1, category: str = None) -> List[Dict]:
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

COMPANY_PROFILE = {
    "name": "SKYGARDEN",
    "services": ["compra", "venta", "tasacion"],
    "description": "Inmobiliaria especializada en compra, venta y tasación de propiedades",
    "email": "contacto@skygarden.com.ar",
    "whatsapp_phone": "+54 9 11 3411 60103",
    "hours": "24 horas",
    "hours_human": "Nuestro horario de atención es de lunes a viernes de 9:00 a 18:00hs.",
    "address": None,
    "phone": None
}


SOCIAL_MEDIA = {
    "facebook": "https://www.facebook.com/skygardeninmobiliaria",
    "instagram": "https://www.instagram.com/skygardeninmobiliaria",
    "youtube": "https://www.youtube.com/channel/UCDfkIndQtjLd-w0Sp1QLpbw",
    "instagram_handle": "@skygardeninmobiliaria",
    "facebook_name": "SKYGARDEN Inmobiliaria",
    "whatsapp_url": "https://api.whatsapp.com/send?phone=540341153160103"
}


def get_company_info() -> Dict:
    return COMPANY_PROFILE
