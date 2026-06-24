"""
ConversationOrchestrator - Main AI Agent Orchestrator

Handles the full conversation lifecycle:
1. Intent detection & slot extraction
2. Query rewrite for RAG
3. Tool call decision
4. Guardrails validation
5. State machine transitions
6. Trace persistence to ai_turns, ai_tool_calls, ai_conversations

Main entry point: orchestrate()
"""
import json
import re
import time as time_module
from datetime import datetime, timezone
from typing import Optional, Any
from openai import OpenAI
from sqlalchemy import text
from sqlalchemy.orm import Session
import httpx

from app.core.config import settings
from app.core.db import get_db
from app.services.knowledge_base import get_ai_agent_config, get_kb_documents, COMPANY_PROFILE, SOCIAL_MEDIA
from app.services.rag_service import RAGService, get_kb_context_for_prompt


# ==================== OPENAI CLIENT ====================

def _is_outside_business_hours(business_hours: dict) -> bool:
    """True when the agent has business hours configured AND now is outside them.

    Supported shapes (saved from the agent config UI):
      {"start": "09:00", "end": "18:00", "days": [1,2,3,4,5]}   # ISO weekday 1=Mon
      {"mon": ["09:00","18:00"], "tue": [...], ...}              # per-day ranges
    Empty/missing config means "always open" (never gate replies).
    """
    if not business_hours or not isinstance(business_hours, dict):
        return False
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(str(business_hours.get("tz") or "America/Argentina/Buenos_Aires"))
        now = datetime.now(tz)
        now_hm = now.strftime("%H:%M")

        if "start" in business_hours and "end" in business_hours:
            days = business_hours.get("days") or [1, 2, 3, 4, 5, 6, 7]
            if now.isoweekday() not in [int(d) for d in days]:
                return True
            start = str(business_hours["start"])
            end = str(business_hours["end"])
            if not start or not end:
                return False
            return not (start <= now_hm <= end)

        day_keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        key = day_keys[now.isoweekday() - 1]
        rng = business_hours.get(key)
        if not rng:
            # Day key present in config but empty/missing → closed that day,
            # but only if at least one other day IS configured
            if any(business_hours.get(k) for k in day_keys):
                return True
            return False
        if isinstance(rng, list) and len(rng) >= 2:
            return not (str(rng[0]) <= now_hm <= str(rng[1]))
        return False
    except Exception as e:
        print(f"[orchestrator] business hours parse error: {e}")
        return False


def get_openai_client() -> Optional[OpenAI]:
    if not settings.openai_api_key:
        return None
    try:
        return OpenAI(api_key=settings.openai_api_key)
    except Exception:
        return None


# ==================== CONVERSATION STATES ====================

CONVERSATION_STATES = {
    "new": "new",
    "qualifying": "qualifying",
    "negotiation": "negotiation",
    "handoff": "handoff",
    "closed": "closed",
}


# ==================== TOOL DEFINITIONS ====================

FUNCTIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_properties",
            "description": "Buscar propiedades en la base de datos de Tokko. USAR OBLIGATORIAMENTE cuando el usuario busque propiedades, departamentos, casas, locales, oficinas, terrenos, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "Zona o barrio (ej: 'palermo', 'belgrano', 'recoleta', 'caballito', 'villa crespo', 'centro')"},
                    "price_max": {"type": "integer", "description": "Precio máximo en USD (ej: 200000 para USD 200,000)"},
                    "price_min": {"type": "integer", "description": "Precio mínimo en USD (ej: 100000 para USD 100,000). Usar cuando el cliente da un rango."},
                    "property_type": {"type": "string", "description": "Tipo: 'apartment', 'house', 'store', 'office', 'land'"},
                    "rooms": {"type": "integer", "description": "Cantidad de ambientes/dormitorios"},
                    "operation_type": {"type": "string", "description": "Tipo de operacion: 'sale' para compra/venta, 'rent' para alquiler. Por defecto 'sale'"},
                    "currency": {"type": "string", "description": "Moneda del presupuesto: 'USD' o 'ARS'. Por defecto USD para compra, ARS para alquiler."},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_company_info",
            "description": "Obtener información de contacto, redes sociales y horarios. USAR cuando pregunte por contacto, redes, Instagram, Facebook, horario, teléfono, email.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_knowledge_base",
            "description": "Consultar la base de conocimiento para información sobre procedimientos, políticas, servicios, preguntas frecuentes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "Categoría: 'general', 'faq', 'procedures', 'tokko'"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "upsert_contact",
            "description": "Crear o actualizar un contacto existente. USAR para guardar datos del lead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "number": {"type": "string", "description": "Número de WhatsApp del contacto"},
                    "name": {"type": "string", "description": "Nombre completo del contacto"},
                    "email": {"type": "string", "description": "Email del contacto"},
                    "business_type": {"type": "string", "description": "Tipo de negocio: 'comprador', 'vendedor', 'inquilino', 'propietario'"},
                    "needs": {"type": "string", "description": "Descripción de necesidades del contacto"},
                },
                "required": ["number"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "agendar_cita",
            "description": "Agenda una cita/turno para un contacto existente.",
            "parameters": {
                "type": "object",
                "properties": {
                    "contact_id": {"type": "integer", "description": "ID del contacto en el sistema"},
                    "starts_at": {"type": "string", "description": "Fecha y hora ISO (ej: '2026-03-25T14:00:00')"},
                    "duration_min": {"type": "integer", "description": "Duración en minutos (default 30)"},
                    "service_type": {"type": "string", "description": "Tipo de servicio: 'visita', 'tasacion', 'reunion', 'general'"},
                    "notes": {"type": "string", "description": "Notas adicionales"},
                },
                "required": ["contact_id", "starts_at"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "consultar_kb",
            "description": "Búsqueda avanzada en la base de conocimiento con soporte híbrido (FTS + embeddings). USAR para cualquier pregunta sobre procedimientos, políticas, servicios.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Pregunta o consulta del usuario"},
                    "top_k": {"type": "integer", "description": "Número de resultados (default 5)"},
                    "category": {"type": "string", "description": "Categoría opcional"},
                },
                "required": ["query"]
            }
        }
    },
]


# ==================== SLOT EXTRACTION ====================

def extract_slots(text: str, company_id: int = None, tenant_config: dict = None) -> dict:
    """Extract structured information (slots) from user message."""
    if company_id is None or int(company_id) <= 0:
        raise ValueError("company_id is required (multi-tenant safety)")
    text_lower = text.lower()
    slots = {}

    # Budget extraction
    # Detect currency hint from text (without blocking extraction)
    _mentions_pesos = bool(re.search(r'(?<![a-z])peso', text_lower))
    _mentions_usd = bool(re.search(r'usd|u\$s|d[oó]lares?', text_lower))
    _mentions_rent = bool(re.search(r'alquil|arriend|renta|inquilin', text_lower))
    if _mentions_usd:
        _budget_currency = 'USD'
    elif _mentions_pesos:
        _budget_currency = 'ARS'
    elif _mentions_rent:
        _budget_currency = 'ARS'
    else:
        _budget_currency = None
    # Legacy flag kept for non-currency pattern guards (millones, thousands scaling).
    # Do NOT use it to skip extraction — always extract and tag currency instead.
    _is_pesos_only = _mentions_pesos and not _mentions_usd

    # Minimum budget: "mínimo X", "como mínimo X", "al menos X", "desde X", "más de X"
    # Also handles reversed: "400mil como mínimo", "400k mínimo"
    # Must check BEFORE max patterns so the same number isn't double-extracted
    _min_captured_value = None
    if True:
        _min_kw = r'(?:m[ií]nimo|como\s+m[ií]nimo|al\s+menos|desde|m[aá]s\s+de|por\s+encima)'
        _num = r'(\d{1,9}(?:[.,]\d{3})*)\s*(k|mil)?'
        # Pattern A: keyword BEFORE number
        _min_pat = re.search(_min_kw + r'\s*(?:us[d$]?\s*)?' + _num, text_lower)
        # Pattern B: number BEFORE keyword (e.g. "400mil como mínimo")
        if not _min_pat:
            _min_pat = re.search(_num + r'\s*(?:us[d$]?\s*)?\s+' + _min_kw, text_lower)
        if _min_pat:
            try:
                _mv = int(re.sub(r'[.,]', '', _min_pat.group(1)))
                _suffix = (_min_pat.group(2) or '').lower()
                if _suffix == 'k' and _mv < 10000: _mv *= 1000
                elif _suffix == 'mil' and _mv < 10000: _mv *= 1000
                if _mv >= 5000:
                    slots['budget_min'] = _mv
                    _min_captured_value = _mv
            except ValueError:
                pass

    budget_patterns = [
        (r'[$]\s*(\d{1,9}(?:[.,]\d{3})*)', 'max'),
        (r'hasta\s*(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)', 'max'),
        (r'm[aá]xim[oaóá]\s*(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)', 'max'),
        (r'(?:presupuesto|rango)\s*(?:de\s*)?(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)', 'max'),
        (r'(\d{1,9}(?:[.,]\d{3})*)\s*(?:us[d$]|d[oó]lares?|dolares)', 'max'),
        (r'(\d{1,9}(?:[.,]\d{3})*)\s*(?:luc|mil)', 'max'),
        (r'(?:tengo|cuento|manejo|disponible)\s*(?:con\s*)?(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)', 'max'),
        (r'(?:tengo|cuento|manejo|disponible)\s+m[aá]x\w*\s*(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)', 'max'),
        (r'(\d{1,9}(?:[.,]\d{3})*)\s*k', 'max'),
    ]
    for pattern, direction in budget_patterns:
        match = re.search(pattern, text_lower)
        if match:
            value = re.sub(r'[.,]', '', match.group(1))
            try:
                budget = int(value)
                explicit_usd = bool(re.search(r'usd|u$s|d[oó]lares?|dolares', text_lower))
                mentions_thousands = bool(re.search(r'luc|mil', text_lower))
                mentions_millones = bool(re.search(r'millon', text_lower))
                mentions_k = bool(re.search(r'\d+\s*k', text_lower)) and budget < 10000
                if mentions_millones:
                    continue
                if mentions_k:
                    budget = budget * 1000
                elif mentions_thousands and budget < 10000:
                    budget = budget * 1000
                # (small number scaling removed - too many false positives)
                pass  # no-op
                # Floor depends on currency + operation (rent USD can be <5000/mo, rent ARS must be >=50k/mo)
                _tc = tenant_config or {}
                _tc_rent = _tc.get("budget_floor_rent")
                _tc_sale = _tc.get("budget_floor_sale")
                _floor = _tc_sale if _tc_sale else 5000  # default: USD sale
                if _budget_currency == "ARS":
                    _floor = _tc_rent if _tc_rent else 50000
                elif _budget_currency == "USD" and _mentions_rent:
                    _floor = 300  # USD rent/mo
                if budget < _floor:
                    continue
                # Don't overwrite budget as max if the same number was already captured as min
                if _min_captured_value and budget == _min_captured_value:
                    break
                slots['budget'] = {'value': budget, 'direction': direction, 'currency': _budget_currency}
                break
            except ValueError:
                pass
    # Range budget: "entre X y Y", "de X a Y" → extracts min AND max
    if True:
        def _parse_amount(raw: str, has_k: bool, has_mil: bool) -> int:
            v = int(re.sub(r'[.,]', '', raw))
            if has_k and v < 10000: v *= 1000
            elif has_mil and v < 10000: v *= 1000
            return v
        _range_pat = re.search(
            r'(?:entre|de)\s*(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)\s*(k|mil)?\s*(?:y|a)\s*(?:us[d$]?\s*)?(\d{1,9}(?:[.,]\d{3})*)\s*(k|mil|usd|d[oó]lares?)?',
            text_lower
        )
        if _range_pat:
            try:
                v1 = _parse_amount(_range_pat.group(1), bool(_range_pat.group(2) == 'k'), bool(_range_pat.group(2) == 'mil'))
                v2 = _parse_amount(_range_pat.group(3), bool(_range_pat.group(4) and 'k' in _range_pat.group(4)), bool(_range_pat.group(4) and 'mil' in _range_pat.group(4)))
                if v1 > 5000 and v2 > 5000:
                    slots['budget_min'] = min(v1, v2)
                    slots['budget'] = {'value': max(v1, v2), 'direction': 'max', 'currency': _budget_currency}
            except Exception:
                pass

    # Written-out Spanish numbers for budget (e.g. "cien mil", "doscientos mil")
    if 'budget' not in slots:
        written_map = {
            'cien': 100, 'ciento': 100,
            'dos': 200, 'doscientos': 200, 'doscientas': 200,
            'trescientos': 300, 'trescientas': 300,
            'cuatrocientos': 400, 'cuatrocientas': 400,
            'quinientos': 500, 'quinientas': 500,
        }
        for word, mult in written_map.items():
            pattern = rf'{word}\s+mil'
            if re.search(pattern, text_lower):
                slots['budget'] = {'value': mult * 1000, 'direction': 'max', 'currency': _budget_currency}
                break

    # Fallback: detect large plain numbers as budget (e.g. tengo 150000 or 320.000)
    if 'budget' not in slots:
        has_phone = bool(re.search(r'llamame|llam[aá]|telefono|cel|celular|whatsapp', text_lower))
        # Match numbers with period-as-thousands-separator: 320.000 / 1.200.000
        dot_match = re.search(r'(\d{1,3}(?:\.\d{3})+)', text)
        if dot_match:
            budget_val = int(re.sub(r'[.]', '', dot_match.group(1)))
            if 5000 <= budget_val <= 5000000 and not has_phone and budget_val != _min_captured_value:
                slots['budget'] = {'value': budget_val, 'direction': 'max', 'currency': _budget_currency}
        # Match plain digit runs: 150000
        if 'budget' not in slots:
            plain_match = re.search(r'(\d{5,9})', text)
            if plain_match:
                budget_val = int(plain_match.group(1))
                if 5000 <= budget_val <= 5000000 and not has_phone and budget_val != _min_captured_value:
                    slots['budget'] = {'value': budget_val, 'direction': 'max', 'currency': _budget_currency}

    # Zone extraction — tenant override wins, else AR defaults
    _tenant_zones = (tenant_config or {}).get('zone_keywords') if tenant_config else None
    if _tenant_zones and isinstance(_tenant_zones, list) and len(_tenant_zones) > 0:
        zone_keywords = [str(z).lower() for z in _tenant_zones]
        priority_zones = zone_keywords  # tenant list treated as single priority bucket
        _zone_source_override = True
    else:
        _zone_source_override = False
        zone_keywords = [
        'palermo', 'belgrano', 'recoleta', 'caballito', 'villa crespo', 'almagro', 'barracas',
        'barrio norte', 'centro', 'microcentro', 'nunez', 'saavedra', 'las cañitas',
        'villa urquiza', 'coghlan', 'urquiza', 'paternal', 'villa del parque', 'velez sarsfield',
        'flores', 'carapachay', 'munro', 'olivos', 'la lucila', 'martinez', 'acassuso',
        'san isidro', 'beccar', 'victorica', 'pilar', 'escobar', 'tigre', 'nordelta',
        'rosario', 'funes', 'roldan', 'roldán', 'fisherton', 'cordoba', 'mendoza', 'buenos aires', 'cap federal', 'capital federal',
        'martin', 'barrio martin', 'pichincha', 'ibarlucea', 'general lagos', 'alvear', 'norte', 'puerto norte', 'new york', 'parque espana',
        'echesortu', 'arroyito', 'tablada', 'la florida', 'adrogue', 'quilmes', 'lomas de zamora', 'san martin',
    ]
    # Priority: neighborhoods > cities > generic zones (AR default when no tenant override)
    if _zone_source_override:
        pass
    else:
        priority_zones = [
        # Rosario neighborhoods (most specific)
        'barrio martin', 'pichincha', 'fisherton', 'echesortu', 'arroyito', 'tablada',
        'la florida', 'ibarlucea', 'general lagos', 'puerto norte', 'parque espana',
        # Buenos Aires neighborhoods
        'barrio norte', 'villa crespo', 'villa urquiza', 'villa del parque',
        'las cañitas', 'san isidro', 'lomas de zamora', 'la lucila', 'velez sarsfield',
        'palermo', 'belgrano', 'recoleta', 'caballito', 'almagro', 'barracas',
        'nunez', 'saavedra', 'coghlan', 'urquiza', 'paternal', 'flores',
        'adrogue', 'quilmes',
        # Specific cities/towns
        'funes', 'roldan', 'roldán', 'pilar', 'escobar', 'tigre', 'nordelta',
        'olivos', 'martinez', 'acassuso', 'beccar', 'victorica', 'carapachay', 'munro',
        'rosario', 'cordoba', 'mendoza', 'cap federal', 'capital federal', 'buenos aires',
        # Generic zones (lowest priority)
        'san martin', 'martin', 'alvear', 'norte', 'microcentro', 'centro', 'new york',
    ]
    for zone in priority_zones:
        if zone in text_lower:
            slots['zone'] = zone.title()
            break

    # Property type
    type_map = {
        'departamento': 'apartment', 'depto': 'apartment', 'depa': 'apartment',
        'casa': 'house', 'chalet': 'house',
        'local': 'store', 'comercio': 'store',
        'oficina': 'office',
        'terreno': 'land', 'lote': 'land',
        'ph': 'ph',
    }
    for keyword, prop_type in type_map.items():
        if keyword in text_lower:
            slots['property_type'] = prop_type
            break

    # Rooms
    rooms_match = re.search(r'(\d+)\s*(?:dormitorio|habitaci[oó]n|dorm|ambiente|amb)', text_lower)
    if rooms_match:
        slots['rooms'] = int(rooms_match.group(1))
    elif re.search(r'monoambiente|mono\s*ambiente|1\s*ambiente|un\s*ambiente', text_lower):
        slots['rooms'] = 1
        # monoambiente implies apartment (studio = depto)
        slots.setdefault('property_type', 'apartment')

    # Explicit opt-out for bedroom filter (overrides remembered rooms)
    if re.search(r'sin\s+filtro\s+de\s+dorm|sin\s+dormitor|sin\s+filtro\s+habitac', text_lower):
        slots['rooms'] = 0

    # "Minimum N" / "N or more" / "N+" -> drop rooms filter (user wants wide search)
    # Examples: "minimo 1", "al menos 2", "1 o mas", "2+", "de 1 ambiente o mas"
    if re.search(r'(?:m[ií]nimo|al\s+menos|por\s+lo\s+menos|desde)\s*\d', text_lower) or \
       re.search(r'\d+\s*(?:o\s+m[aá]s|o\s+mayor|\+\s|\+$)', text_lower) or \
       re.search(r'\d+\s*(?:ambiente|amb|dorm|habitaci)\w*\s+o\s+m[aá]s', text_lower):
        slots['rooms'] = 0

    bathrooms_match = re.search(r'(\d+)\s*(?:baño|banio|bath)', text_lower)
    if bathrooms_match:
        slots['bathrooms'] = int(bathrooms_match.group(1))

    # Contact info
    phone_match = re.search(r'[\+]?(\d{6,15})', text)
    if phone_match:
        slots['phone'] = phone_match.group(1)

    email_match = re.search(r'[\w.+-]+@[\w-]+\.[\w.-]+', text)
    if email_match:
        slots['email'] = email_match.group(0)

    # Name extraction (runs on text_lower)
    _name_pats = [
        r'(?:me llamo|mi nombre es|llamame|llamenme)[\s,]+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)*)',
        r'(?:^|\s)soy\s+([a-záéíóúñ]{2,}(?:\s+[a-záéíóúñ]{2,})?)',
    ]
    _name_skip = {'rosario', 'funes', 'departamento', 'casa', 'terreno', 'dolares', 'pesos', 'usd',
                  'un', 'una', 'el', 'la', 'de', 'del', 'en', 'con', 'para', 'que', 'no', 'si',
                  'por', 'al', 'los', 'las', 'le', 'se', 'me', 'tu', 'su'}
    for _np in _name_pats:
        _nm = re.search(_np, text_lower)
        if _nm:
            _name_val = _nm.group(1).strip().title()
            _name_words = _name_val.lower().split()
            if not any(w in _name_skip for w in _name_words) and len(_name_val) >= 3:
                slots['name'] = _name_val
                break

    # Operation type: rent vs sale
    _rent_kw = r'alquil|arriend|renta|inquilin'
    _sale_kw = r'compr|vend|venta|escritur|adquir'
    if re.search(_rent_kw, text_lower):
        slots['operation'] = 'rent'
    elif re.search(_sale_kw, text_lower):
        slots['operation'] = 'sale'

    return slots


# ==================== INTENT CLASSIFICATION ====================

def classify_intent(text: str, conversation_state: str = "new") -> dict:
    """Classify user intent using keyword matching + context."""
    text_lower = text.lower().strip()

    if any(k in text_lower for k in ['chau', 'nos vemos', 'hasta luego', 'adiós']):
        return {"intent": "goodbye", "confidence": 0.95, "action": "close_conversation"}

    _greet_tokens = ['hola', 'buenas', 'hi', 'hello', 'buen día', 'buenos días', 'buen dia']
    if any(k in text_lower for k in _greet_tokens):
        # Strip greetings + small filler, check if substantive content remains
        _stripped = text_lower
        for _g in _greet_tokens + ['che', 'como estas', 'como estás', 'cómo estás', 'todo bien', 'que tal', 'qué tal', '!', '?', '.', ',']:
            _stripped = _stripped.replace(_g, ' ')
        _stripped = re.sub(r'\s+', ' ', _stripped).strip()
        # Pure greeting → welcome path
        if len(_stripped) < 4:
            action = "welcome" if conversation_state == "new" else "continue"
            return {"intent": "greeting", "confidence": 0.95, "action": action}
        # Greeting + content → classify on stripped text
        text_lower = _stripped

    # Check "not interested" BEFORE property_signals to avoid "me interesa" false-positives
    not_interested_signals = [
        'ninguna', 'ninguno', 'no me interesa', 'no me interesan',
        'no me gusta', 'no me gustan', 'no me convence', 'no me convencen',
        'no me llama la atención', 'no me llaman la atención',
        'no son lo que busco', 'no es lo que busco',
        'no me atraen', 'no me atrae', 'ninguna me interesa',
        'ninguno me interesa', 'no me convencen', 'no me llegó ninguna',
        'no me llega ninguna', 'paso de todas', 'no me copa ninguna',
        'no me copan', 'no me cierra ninguna', 'no me cierran',
    ]
    if any(k in text_lower for k in not_interested_signals):
        return {"intent": "not_interested", "confidence": 0.9, "action": "handle_not_interested"}

    # Check more_signals BEFORE property_signals to avoid "ver" false-positives
    more_signals_early = ['ver más', 'ver mas', 'más opciones', 'mas opciones',
                          'mostrar más', 'mostrar mas', 'ver el resto', 'ver las otras',
                          'ver otras', 'el resto', 'las demas', 'las demás']
    if any(k in text_lower for k in more_signals_early):
        return {"intent": "more_results", "confidence": 0.95, "action": "show_more_results"}

    # Interest in a SPECIFIC shown property — check before generic property_signals
    # to avoid re-triggering a new search when user picks one
    property_interest_signals = [
        'me interesa la de', 'me interesa esa', 'me interesa ese', 'me interesa el',
        'me interesa la primera', 'me interesa la segunda', 'me interesa la tercera',
        'me interesa la cuarta', 'me interesa la quinta',
        'me gusta la de', 'me gusta esa', 'me gusta ese',
        'ya me interesa', 'esa me interesa', 'ese me interesa',
        'quiero saber más de', 'quiero saber mas de', 'más info de', 'mas info de',
        'info de la', 'info del', 'me quedo con', 'quiero esa', 'quiero ese',
        'la primera', 'la segunda', 'la tercera', 'la cuarta', 'la quinta',
        'el primero', 'el segundo', 'el tercero',
    ]
    if any(k in text_lower for k in property_interest_signals):
        return {"intent": "property_interest", "confidence": 0.92, "action": "handle_property_interest"}

    # KB-style yes/no questions about policies → route to KB before property_search
    # Fire only when text looks like a question (ends with ? or contains question verb)
    _is_question = text_lower.endswith('?') or bool(re.match(r'^(acept|permit|incluy|cu[áa]l|cu[aá]ndo|c[oó]mo|qu[eé] )', text_lower))
    _kb_topic_words = ['mascota', 'perro', 'gato', 'cochera', 'garage', 'pileta', 'amenit',
                       'expensa', 'comisi[oó]n', 'honorario', 'seguro', 'iva', 'garant[íi]a',
                       'firma', 'contrato', 'requisit', 'documentaci[oó]n', 'acepta', 'permite', 'incluy']
    if _is_question and any(re.search(w, text_lower) for w in _kb_topic_words):
        return {"intent": "knowledge_query", "confidence": 0.85, "action": "query_kb"}

    property_signals = ['buscar', 'busco', 'quiero', 'necesito', 'ver', 'propiedad',
                        'departamento', 'casa', 'local', 'oficina', 'terreno', 'me interesa',
                        'comprar', 'venta', 'tasar', 'vender', 'alquilar', 'alquiler']
    if any(k in text_lower for k in property_signals):
        return {"intent": "property_search", "confidence": 0.85, "action": "collect_slots_or_search"}

    contact_signals = ['contacto', 'teléfono', 'telefono', 'email', 'correo', 'whatsapp',
                       'horario', 'dirección', 'direccion', 'instagram', 'redes', 'ubicación']
    if any(k in text_lower for k in contact_signals):
        return {"intent": "contact_info", "confidence": 0.9, "action": "provide_contact_info"}

    price_signals = ['precio', 'costo', 'cuánto', 'cuanto sale', 'vale', 'presupuesto']
    if any(k in text_lower for k in price_signals):
        return {"intent": "pricing", "confidence": 0.85, "action": "collect_budget_or_search"}

    appt_signals = ['agendar', 'cita', 'turno', 'visita', 'reunión', 'reunion',
                    'cuando puedo', 'disponibilidad', 'horario', 'agenda']
    if any(k in text_lower for k in appt_signals):
        return {"intent": "schedule_appointment", "confidence": 0.9, "action": "collect_appointment_info"}

    kb_signals = ['cómo', 'como funciona', 'procedimiento', 'política', 'politica',
                  'requisito', 'documentación', 'que incluyen', 'que me ofrecen']
    if any(k in text_lower for k in kb_signals):
        return {"intent": "knowledge_query", "confidence": 0.8, "action": "query_kb"}

    expand_signals = [
        'amplia', 'ampliá', 'ampliar', 'amplíe', 'amplie', 'ensancha', 'abrí', 'abri',
        'más zona', 'mas zona', 'más precio', 'mas precio', 'rango de precio',
        'subi el precio', 'subí el precio', 'aumenta el precio', 'aumentá el precio'
    ]
    if any(k in text_lower for k in expand_signals):
        return {"intent": "property_search", "confidence": 0.9, "action": "collect_slots_or_search"}

    # Resend signals — user wants to SEE THE SAME cards again (not next batch)
    resend_signals = [
        'enviamelas de nuevo', 'enviamela de nuevo', 'mandamelas de nuevo',
        'mandamela de nuevo', 'pasamelas de nuevo', 'pasamela de nuevo',
        'enviamelas otra vez', 'mandamelas otra vez', 'pasamelas otra vez',
        'reenvialas', 'reenvialos', 'reenvia', 'reenviá', 'reenviamelas',
        'volveme a mandar', 'volveme a enviar', 'volve a mandarmelas',
        'volve a enviarmelas', 'volve a pasarmelas', 'repetilas', 'repetilos',
        'repetime', 'de vuelta', 'otra vez las', 'otra vez esas', 'mostralas de nuevo',
        'mandame de nuevo', 'enviame de nuevo', 'pasame de nuevo',
    ]
    if any(k in text_lower for k in resend_signals):
        return {"intent": "resend_results", "confidence": 0.95, "action": "resend_last_results"}

    more_signals = ['más opciones', 'mas opciones', 'ver más', 'ver mas',
                    'mostrar más', 'mostrar mas', 'otras opciones', 'otras propiedades',
                    'más propiedades', 'mas propiedades', 'más casas', 'mas casas',
                    'más departamentos', 'mas departamentos', 'seguir viendo',
                    'quiero ver más', 'quiero ver mas', 'siguiente',
                    'mostramelas', 'mostrámelas', 'mostrame mas', 'mostrá más',
                    'mandame mas', 'mandame más', 'enviame mas', 'enviame más',
                    'manda más', 'manda mas', 'si dale', 'dale mostrame',
                    'dale mostrá', 'mostra mas', 'mostrá mas', 'quiero ver',
                    'ver las otras', 'ver otras', 'ver el resto', 'el resto',
                    'las demas', 'las demás', 'mostrame las otras',
                    'aver', 'a ver', 'veamos', 'vemos', 'dale aver',
                    'dale a ver', 'listo', 'vamos', 'sí dale', 'si dale muestra']
    if any(k in text_lower for k in more_signals):
        return {"intent": "more_results", "confidence": 0.95, "action": "show_more_results"}

    # Word-boundary match — avoid 'así', 'casi', 'ok' inside other words
    if re.search(r'(?<![\wáéíóúñ])(s[ií]|correcto|dale|perfecto|ok|okay|listo|va)(?![\wáéíóúñ])', text_lower):
        return {"intent": "confirmation", "confidence": 0.8, "action": "continue_conversation"}

    objection_signals = ['muy caro', 'caro', 'no puedo', 'fuera de presupuesto',
                         'no me conviene', 'demasiado']
    if any(k in text_lower for k in objection_signals):
        return {"intent": "objection", "confidence": 0.85, "action": "handle_objection"}

    return {"intent": "general", "confidence": 0.5, "action": "general_response"}


# ==================== STATE MACHINE ====================

VALID_STATES = frozenset({
    "new", "qualifying", "negotiation", "handoff", "closed",
})


def _coerce_state(state: str) -> str:
    """Return state if valid, else qualifying."""
    return state if state in VALID_STATES else "qualifying"


def _tokens_kwarg(model: str, n: int) -> dict:
    """Return the correct token-limit kwarg for the given model.

    gpt-5 and o-series models use max_completion_tokens; older models use max_tokens.
    """
    new_style = model.startswith(("gpt-5", "o1", "o3", "o4"))
    key = "max_completion_tokens" if new_style else "max_tokens"
    return {key: n}


def _temperature_kwarg(model: str, t: float) -> dict:
    """gpt-5 only supports the default temperature (1). Skip the param for those models."""
    if model.startswith(("gpt-5", "o1", "o3", "o4")):
        return {}
    return {"temperature": t}


def compute_next_state(current_state: str, intent: str, slots: dict) -> str:
    """Determine next conversation state based on current state + intent."""
    transitions = {
        ("new", "greeting"): "qualifying",
        ("new", "property_search"): "qualifying",
        ("new", "contact_info"): "qualifying",
        ("new", "schedule_appointment"): "qualifying",
        ("new", "knowledge_query"): "qualifying",
        ("new", "general"): "qualifying",
        ("new", "goodbye"): "closed",
        ("qualifying", "property_search"): "negotiation",
        ("qualifying", "schedule_appointment"): "handoff",
        ("qualifying", "contact_info"): "qualifying",
        ("qualifying", "pricing"): "negotiation",
        ("qualifying", "goodbye"): "closed",
        ("negotiation", "property_search"): "negotiation",
        ("negotiation", "schedule_appointment"): "handoff",
        ("negotiation", "objection"): "negotiation",
        ("negotiation", "goodbye"): "closed",
        ("handoff", "confirmation"): "handoff",
        ("handoff", "goodbye"): "closed",
    }
    return _coerce_state(transitions.get((current_state, intent), current_state))




def _tokko_log(event: str, **payload: Any) -> None:
    """Structured logger for Tokko search pipeline."""
    try:
        print("[tokko]", json.dumps({"event": event, **payload}, ensure_ascii=False, default=str))
    except Exception:
        print(f"[tokko] {event} {payload}")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value or default)
    except Exception:
        return default


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _canonical_property_type(value: Any) -> str:
    raw = _normalize_text(value)
    if not raw:
        return ""
    aliases = {
        "apartment": {"apartment", "departamento", "depto", "dpto", "condominio", "condo"},
        "house": {"house", "casa", "chalet"},
        "store": {"store", "local", "local comercial"},
        "office": {"office", "oficina"},
        "land": {"land", "terreno", "lote"},
        "ph": {"ph"},
    }
    tokens = set(re.findall(r"[a-z0-9]+", raw))
    if raw in aliases:
        return raw
    for canonical, values in aliases.items():
        if raw in values:
            return canonical
        if tokens.intersection(values):
            return canonical
    return raw


def _type_matches_strict(raw_type: Any, requested_type: str) -> bool:
    if not requested_type:
        return True
    return _canonical_property_type(raw_type) == _canonical_property_type(requested_type)


def _extract_primary_price(property_obj: dict, operation_type: str = "sale", currency: str | None = None) -> tuple[int, str]:
    """Extract primary price. If `currency` given, only match prices in that currency (strict).
    If `currency` is None, prefer USD then fall back to any price."""
    if property_obj.get("operations"):
        for op in property_obj["operations"]:
            op_t = str(op.get("operation_type", "")).lower()
            is_rent = op_t in ("rent", "alquiler", "rental")
            is_sale = op_t in ("sale", "venta", "compra")
            want_rent = operation_type == "rent"
            if (want_rent and is_rent) or (not want_rent and is_sale):
                for price_info in op.get("prices", []):
                    pc = str(price_info.get("currency", "")).upper() or "USD"
                    if currency and pc != currency.upper():
                        continue
                    pv = _safe_int(price_info.get("price"), 0)
                    if pv and pv > 1:  # price=1 is Tokko placeholder — skip
                        suffix = "/mes" if want_rent else ""
                        return pv, f"{pc} {pv:,}{suffix}"
        # fallback: any price (only when currency is not strictly required)
        if not currency:
            for op in property_obj["operations"]:
                for price_info in op.get("prices", []):
                    pv = _safe_int(price_info.get("price"), 0)
                    if pv and pv > 1:
                        pc = str(price_info.get("currency", "")).upper() or "USD"
                        return pv, f"{pc} {pv:,}"
    return 0, "Consultar"


def _map_tokko_property(p: dict) -> dict:
    photo = ""
    if p.get("photos") and len(p["photos"]) > 0:
        photo = p["photos"][0].get("image", "")

    price_val, price = _extract_primary_price(p)
    location = (p.get("location") or {}).get("full_location") or "Argentina"
    prop_type_raw = p.get("type", "property")
    rooms_val = p.get("room_amount") or p.get("bedroom_amount") or p.get("rooms") or ""

    op_types = [str(op.get("operation_type", "")).lower() for op in p.get("operations", []) if op.get("operation_type")]
    has_rent = any(t in ("rent", "alquiler", "rental") for t in op_types)
    has_sale = any(t in ("sale", "venta", "compra") for t in op_types)

    return {
        "id": p.get("id", 0),
        "title": p.get("address") or p.get("publication_title") or "Propiedad",
        "price": price,
        "price_value": price_val,
        "location": location,
        "type": str(prop_type_raw),
        "type_normalized": _canonical_property_type(prop_type_raw),
        "url": p.get("public_url") or f"https://ficha.info/p/{p.get('id', '')}",
        "photo": photo,
        "rooms": rooms_val,
        "bathrooms": p.get("bathroom_amount", ""),
        "area": p.get("livable_area", ""),
        "has_rent": has_rent,
        "has_sale": has_sale,
        "operation_types": op_types,
        "_raw_operations": p.get("operations", []),
    }


def _normalize_search_results(payload: Any) -> list[dict]:
    """Normalize various tool result shapes into a deterministic list."""
    if isinstance(payload, dict):
        # execute_tool shape
        if isinstance(payload.get("results"), list):
            return [r for r in payload["results"] if isinstance(r, dict)]
        # tokko raw shape
        if isinstance(payload.get("objects"), list):
            return [_map_tokko_property(p) for p in payload["objects"] if isinstance(p, dict)]
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    return []


def _dedupe_properties(items: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for it in items:
        key = str(it.get("id") or it.get("url") or f"{it.get('title')}|{it.get('location')}")
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def _render_property_results(items: list[dict], limit: int = 3) -> str:
    NL = chr(10)
    PIN = chr(0x1F4CD)
    PCC = chr(0x1F4CC)
    MON = chr(0x1F4B0)
    LNK = chr(0x1F517)
    entries = []
    for i, prop in enumerate(items[:limit], start=1):
        title = prop.get("title") or "Propiedad"
        loc_full = (prop.get("location") or "Sin zona")
        loc_parts = [p.strip() for p in loc_full.replace(" | ", ",").split(",") if p.strip()]
        location = ", ".join(loc_parts[-2:]) if len(loc_parts) >= 2 else loc_full
        price = prop.get("price") or "Consultar"
        if 0 < _safe_int(prop.get("price_value", 0), 0) < 100:
            price = "Consultar"
        rooms = prop.get("rooms")
        rooms_txt = f" | {rooms} amb." if rooms else ""
        url = prop.get("url") or ""
        # Skip fallback URLs with no real ID (https://ficha.info/p/)
        if url and url.rstrip("/").endswith("/p/"):
            url = ""
        url_line = (NL + LNK + " " + url) if url else ""
        photo = prop.get("photo") or ""
        photo_txt = f" [FOTO:{photo}]" if photo else ""
        caption = (
            PIN + " " + title + NL
            + PCC + " " + location + NL
            + MON + " " + price + rooms_txt + url_line
        )
        entries.append(caption + photo_txt)
    if not entries:
        return "Te paso opciones concretas: sin publicaciones disponibles ahora mismo."
    # Single-line payload; ||| separates cards
    return "Te paso opciones concretas: " + " ||| ".join(entries)


# ==================== TOOL EXECUTORS ====================

def _enrich_search_args(args: dict, slots: dict) -> dict:
    """Override operation_type + currency in search_properties args from slots.
    The LLM often omits these; slot values are authoritative."""
    if not isinstance(args, dict):
        return args
    out = dict(args)
    slot_op = (slots or {}).get("operation")
    if slot_op in ("rent", "sale"):
        out["operation_type"] = slot_op
    budget_dict = (slots or {}).get("budget") or {}
    slot_cur = budget_dict.get("currency") if isinstance(budget_dict, dict) else None
    if slot_cur in ("ARS", "USD"):
        out["currency"] = slot_cur
    elif out.get("operation_type") in ("rent", "sale"):
        # Operation-derived currency trumps LLM guess (AR market: rent=ARS, sale=USD)
        out["currency"] = "ARS" if out["operation_type"] == "rent" else "USD"
    elif not out.get("currency"):
        out["currency"] = "USD"
    return out


_STATUS_TO_POS = {
    "open": 0, "nuevo": 0, "new": 0, "primer_contacto": 0, "sin_contactar": 0,
    "contactado": 1, "en_conversacion": 1,
    "calificacion": 2, "calificado": 2, "interesado": 2,
    "propuesta": 3, "negociacion": 3,
    "cierre": 4, "ganado": 4, "won": 4, "cerrado": 4,
}


def _sync_stage_from_status(db, company_id: int, contact_id: int, lead_status: str) -> None:
    """Map the inferred free-text leadStatus to the company pipeline stage and update contacts.stage_id,
    so the Kanban board reflects the agent's progress. Matches by stage name first, then by position."""
    if not lead_status:
        return
    from sqlalchemy import text as _t
    ls = str(lead_status).strip().lower()
    stages = db.execute(
        _t('SELECT id, name, position FROM lead_stages WHERE company_id = :c ORDER BY position, id'),
        {"c": company_id},
    ).mappings().all()
    if not stages:
        return
    target = None
    for s in stages:
        if str(s["name"]).strip().lower() == ls:
            target = s["id"]; break
    if target is None:
        pos = _STATUS_TO_POS.get(ls)
        if pos is None:
            return
        pos = min(pos, len(stages) - 1)
        target = stages[pos]["id"]
    db.execute(
        _t('UPDATE contacts SET stage_id = :sid WHERE id = :cid AND "companyId" = :c AND (stage_id IS DISTINCT FROM :sid)'),
        {"sid": target, "cid": contact_id, "c": company_id},
    )


async def execute_tool(
    tool_name: str,
    tool_args: dict,
    company_id: int = None,
    db: Session = None,
) -> dict:
    """Execute a tool and return results."""
    if company_id is None or int(company_id) <= 0:
        raise ValueError("company_id is required (multi-tenant safety)")

    if tool_name == "search_properties":
        # Check if company is a real estate company (inmobiliaria)
        if db:
            try:
                industry_row = db.execute(
                    text('SELECT industry FROM companies WHERE id = :company_id LIMIT 1'),
                    {"company_id": company_id}
                ).mappings().first()
                industry = industry_row["industry"].lower() if industry_row else "inmobiliaria"
                if industry not in ("inmobiliaria", "real estate", "realestate", "agencia inmobiliaria", "broker"):
                    return {
                        "ok": True,
                        "results": [],
                        "message": "B?squeda de propiedades no disponible para este tipo de empresa. Tokko solo est? habilitado para inmobiliarias.",
                        "meta": {"disabled_by_industry": True, "industry": industry},
                    }
            except Exception as e:
                print(f"[orchestrator] Industry check error: {e}")
                # Default to allow for backwards compatibility

        try:
            # Get per-company Tokko API key (fall back to global env key)
            company_tokko_key = settings.tokko_api_key
            if db:
                try:
                    co_row = db.execute(
                        text("SELECT tokko_api_key, tokko_base_url FROM companies WHERE id = :cid LIMIT 1"),
                        {"cid": company_id}
                    ).mappings().first()
                    if co_row and co_row["tokko_api_key"]:
                        company_tokko_key = co_row["tokko_api_key"]
                except Exception:
                    pass
            tokko_url = settings.tokko_api_url or "https://api.tokkobroker.com/api/v1"

            requested_location = _normalize_text(tool_args.get("location"))
            requested_type = _canonical_property_type(tool_args.get("property_type"))
            requested_price_max = _safe_int(tool_args.get("price_max"), 0)
            requested_price_min = _safe_int(tool_args.get("price_min"), 0)
            requested_rooms = _safe_int(tool_args.get("rooms"), 0)
            requested_operation = (tool_args.get("operation_type") or "sale").lower().strip()
            # Currency: explicit tool arg wins; else ARS for rent, USD for sale (Argentine convention)
            _req_cur_raw = (tool_args.get("currency") or "").upper().strip()
            if _req_cur_raw in ("USD", "ARS"):
                requested_currency = _req_cur_raw
            else:
                requested_currency = "ARS" if requested_operation == "rent" else "USD"

            # Server-side Tokko filter via /property/search/ (avoids 200-item client-side cap)
            _TOKKO_OP_IDS = {"sale": 1, "rent": 2, "temp_rent": 3}
            _TOKKO_TYPE_IDS = {
                "apartment": [2, 13, 31],
                "house": [3, 4, 25],
                "office": [5, 30],
                "store": [7],
                "land": [1, 26, 27],
                "ph": [2, 13],
            }
            _TOKKO_TYPE_IDS_ALL = [1, 2, 3, 4, 5, 7, 10, 13, 23, 24, 25, 26, 27, 30, 31]
            _op_id = _TOKKO_OP_IDS.get(requested_operation, 1)
            _type_ids = _TOKKO_TYPE_IDS.get(requested_type) or _TOKKO_TYPE_IDS_ALL
            _tokko_data = {
                "operation_types": [_op_id],
                "property_types": _type_ids,
                "price_from": requested_price_min or 0,
                "price_to": requested_price_max or 99999999,
                "currency": requested_currency,
            }
            _data_json = json.dumps(_tokko_data)

            MAX_TOTAL = 1000
            PAGE_SIZE = 200
            properties = []
            offset = 0
            total_count_server = None
            search_ok = False
            try:
                async with httpx.AsyncClient() as client:
                    while len(properties) < MAX_TOTAL:
                        _p = {
                            "key": company_tokko_key,
                            "limit": PAGE_SIZE,
                            "offset": offset,
                            "format": "json",
                            "data": _data_json,
                        }
                        r = await client.get(f"{tokko_url}/property/search/", params=_p, timeout=20)
                        if r.status_code != 200:
                            break
                        d = r.json()
                        batch = d.get("objects", []) or []
                        if not batch and offset == 0:
                            search_ok = True
                            break
                        properties.extend(batch)
                        search_ok = True
                        if total_count_server is None:
                            total_count_server = int((d.get("meta") or {}).get("total_count") or 0)
                        if len(batch) < PAGE_SIZE or (total_count_server and len(properties) >= total_count_server):
                            break
                        offset += PAGE_SIZE
            except Exception as _tokko_err:
                try:
                    _tokko_log("search_error", error=str(_tokko_err))
                except Exception:
                    pass
                search_ok = False

            if not search_ok:
                params = {"key": company_tokko_key, "limit": 200}
                async with httpx.AsyncClient() as client:
                    response = await client.get(f"{tokko_url}/property/", params=params, timeout=15)
                if response.status_code != 200:
                    return {"ok": False, "error": f"Tokko API error: {response.status_code}"}
                properties = (response.json()).get("objects", [])[:200]

            _tokko_log("search", endpoint=("search" if search_ok else "legacy"), fetched=len(properties), server_total=total_count_server)

            mapped = [_map_tokko_property(p) for p in properties if isinstance(p, dict)]
            # Filter out placeholder-priced properties (price 1-99 = Tokko test data)
            mapped = [p for p in mapped if not (0 < _safe_int(p.get("price_value"), 0) < 100)]
            _tokko_log("mapping", total_raw=len(properties), total_mapped=len(mapped), args=tool_args, currency=requested_currency)

            def _passes(prop, loc=True, rooms=True, type_filter=True):
                if loc and requested_location and requested_location not in _normalize_text(prop.get("location")):
                    return False
                if type_filter and requested_type and not _type_matches_strict(prop.get("type"), requested_type):
                    return False
                if requested_operation == "rent" and not prop.get("has_rent", True):
                    return False
                if requested_operation == "sale" and not prop.get("has_sale", True):
                    return False
                # Currency-aware price pick: strict match for requested currency
                if prop.get("_raw_operations"):
                    op_price, op_label = _extract_primary_price(
                        {"operations": prop["_raw_operations"]},
                        requested_operation,
                        requested_currency,
                    )
                    if op_price == 0:
                        # No price in requested currency for requested operation → discard
                        return False
                    check_price = op_price
                    # Stash correctly-currency'd display for post-filter overwrite
                    prop["_display_price"] = op_label
                    prop["_display_price_value"] = op_price
                else:
                    check_price = _safe_int(prop.get("price_value"), 0)
                if requested_price_max and check_price and check_price > requested_price_max:
                    return False
                if requested_price_min and check_price and check_price > 0 and check_price < requested_price_min:
                    return False
                if rooms and requested_rooms and prop.get("rooms") and _safe_int(prop.get("rooms"), 0) < requested_rooms:
                    return False
                return True

            def _apply_display(results):
                for p in results:
                    if p.get("_display_price"):
                        p["price"] = p["_display_price"]
                        p["price_value"] = p["_display_price_value"]
                        p.pop("_display_price", None)
                        p.pop("_display_price_value", None)
                return results

            # Strict: location + type + budget + rooms
            strict = _apply_display(_dedupe_properties([p for p in mapped if _passes(p, loc=True, rooms=True)]))
            if strict:
                _tokko_log("results", stage="strict", count=len(strict))
                return {"ok": True, "results": strict, "meta": {"fallback_used": False, "requested": tool_args}}

            fallback_meta = {"fallback_used": True, "requested": tool_args, "strategies": []}

            # Fallback 1: relax rooms (keep location + type + budget)
            if requested_rooms:
                fallback_meta["strategies"].append("relax_rooms")
                no_rooms = _apply_display(_dedupe_properties([p for p in mapped if _passes(p, loc=True, rooms=False)]))
                if no_rooms:
                    _tokko_log("fallback", strict_count=0, fallback_count=len(no_rooms), meta=fallback_meta)
                    return {"ok": True, "results": no_rooms, "meta": fallback_meta}

            # Fallback 2: relax location (keep type + budget + rooms)
            fallback_meta["strategies"].append("relax_location")
            no_loc = _apply_display(_dedupe_properties([p for p in mapped if _passes(p, loc=False, rooms=True)]))
            if no_loc:
                _tokko_log("fallback", strict_count=0, fallback_count=len(no_loc), meta=fallback_meta)
                return {"ok": True, "results": no_loc, "meta": fallback_meta}

            # Fallback 3: type + budget only
            fallback_meta["strategies"].append("relax_all")
            any_match = _apply_display(_dedupe_properties([p for p in mapped if _passes(p, loc=False, rooms=False)]))
            if any_match:
                _tokko_log("fallback", strict_count=0, fallback_count=len(any_match), meta=fallback_meta)
                return {"ok": True, "results": any_match, "meta": fallback_meta}

            # Fallback 4: relax type — same location + budget, any property type
            # Surfaces alternatives (e.g. apartments when user asked for house)
            if requested_type:
                fallback_meta["strategies"].append("relax_type")
                alt_type = _apply_display(_dedupe_properties([p for p in mapped if _passes(p, loc=True, rooms=False, type_filter=False)]))
                if alt_type:
                    fallback_meta["type_relaxed"] = True
                    fallback_meta["requested_type"] = requested_type
                    _tokko_log("fallback", strict_count=0, fallback_count=len(alt_type), meta=fallback_meta)
                    return {"ok": True, "results": alt_type, "meta": fallback_meta}

            # Fallback 5: relax type + location
            if requested_type:
                fallback_meta["strategies"].append("relax_type_and_loc")
                alt_any = _apply_display(_dedupe_properties([p for p in mapped if _passes(p, loc=False, rooms=False, type_filter=False)]))
                if alt_any:
                    fallback_meta["type_relaxed"] = True
                    fallback_meta["requested_type"] = requested_type
                    _tokko_log("fallback", strict_count=0, fallback_count=len(alt_any), meta=fallback_meta)
                    return {"ok": True, "results": alt_any, "meta": fallback_meta}

            _tokko_log("fallback", strict_count=0, fallback_count=0, meta=fallback_meta)
            return {"ok": True, "results": [], "meta": fallback_meta}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    elif tool_name == "get_company_info":
        # Get per-company info from database
        company_name = COMPANY_PROFILE.get("name", "Empresa")
        company_email = COMPANY_PROFILE.get("email", "")
        if db:
            try:
                co_row = db.execute(
                    text("SELECT name, email FROM companies WHERE id = :cid LIMIT 1"),
                    {"cid": company_id}
                ).mappings().first()
                if co_row:
                    company_name = co_row["name"] or company_name
                    company_email = co_row["email"] or company_email
            except Exception:
                pass
        ai_cfg = get_ai_agent_config(company_id)
        return {
            "ok": True,
            "results": {
                "name": company_name,
                "email": company_email,
                "agent_name": ai_cfg.get("name", ""),
                "hours": ai_cfg.get("business_hours", {}) or COMPANY_PROFILE.get("hours_human", ""),
            }
        }

    elif tool_name == "get_knowledge_base":
        category = tool_args.get("category")
        docs = get_kb_documents(company_id)
        if category:
            docs = [d for d in docs if d.get("category") == category]
        return {"ok": True, "results": docs}

    elif tool_name == "consultar_kb":
        query = tool_args.get("query", "")
        top_k = min(5, max(1, int(tool_args.get("top_k", 5))))
        category = tool_args.get("category")
        context, citations = get_kb_context_for_prompt(
            query=query, company_id=company_id, max_chars=3000, top_k=top_k,
        )
        return {"ok": True, "results": context, "citations": citations}

    elif tool_name == "upsert_contact":
        if not db:
            return {"ok": False, "error": "DB session required for upsert_contact"}
        number = re.sub(r"\D", "", str(tool_args.get("number", "")))
        if not number:
            return {"ok": False, "error": "number requerido"}
        try:
            existing = db.execute(
                text('SELECT id FROM contacts WHERE "companyId" = :companyId AND number = :number LIMIT 1'),
                {"companyId": company_id, "number": number}
            ).mappings().first()
            if existing:
                db.execute(
                    text('UPDATE contacts SET name = COALESCE(:name, name), email = COALESCE(:email, email), business_type = COALESCE(:business_type, business_type), needs = COALESCE(:needs, needs), "updatedAt" = NOW() WHERE id = :id'),
                    {"id": existing["id"], "name": tool_args.get("name"), "email": tool_args.get("email"),
                     "business_type": tool_args.get("business_type"), "needs": tool_args.get("needs")}
                )
                contact_id = existing["id"]
            else:
                row = db.execute(
                    text('INSERT INTO contacts (name, number, email, isGroup, "companyId", business_type, needs, lead_score, createdAt, "updatedAt") VALUES (:name, :number, :email, false, :companyId, :business_type, :needs, 0, NOW(), NOW()) RETURNING id'),
                    {"name": tool_args.get("name") or number, "number": number, "email": tool_args.get("email") or "", "companyId": company_id,
                     "business_type": tool_args.get("business_type"), "needs": tool_args.get("needs")}
                ).mappings().first()
                contact_id = row["id"] if row else None
            db.commit()
            return {"ok": True, "contact_id": contact_id}
        except Exception as e:
            try: db.rollback()
            except Exception: pass
            return {"ok": False, "error": str(e)}

    elif tool_name == "agendar_cita":
        if not db:
            return {"ok": False, "error": "DB session required for agendar_cita"}
        contact_id = int(tool_args.get("contact_id", 0))
        starts_at = str(tool_args.get("starts_at", ""))
        if not contact_id or not starts_at:
            return {"ok": False, "error": "contact_id y starts_at requeridos"}
        try:
            from datetime import timedelta
            duration = int(tool_args.get("duration_min", 30))
            end_dt = datetime.fromisoformat(starts_at.replace("Z", "+00:00")) + timedelta(minutes=duration)
            row = db.execute(
                text("""INSERT INTO appointments (company_id, contact_id, starts_at, ends_at, service_type, status, notes, created_at, updated_at)
                    VALUES (:companyId, :contactId, :startsAt, :endsAt, :serviceType, 'scheduled', :notes, NOW(), NOW()) RETURNING *"""),
                {"companyId": company_id, "contactId": contact_id, "startsAt": starts_at,
                 "endsAt": end_dt.isoformat(), "serviceType": tool_args.get("service_type") or "general",
                 "notes": tool_args.get("notes") or ""}
            ).mappings().first()
            db.commit()
            _appt = dict(row) if row else None
            if _appt:
                for _k, _v in list(_appt.items()):
                    if isinstance(_v, datetime):
                        _appt[_k] = _v.isoformat()
            return {"ok": True, "appointment": _appt}
        except Exception as e:
            try: db.rollback()
            except Exception: pass
            return {"ok": False, "error": str(e)}

    return {"ok": False, "error": f"Unknown tool: {tool_name}"}

# ==================== GUARDRAILS ====================

def apply_guardrails(reply_text: str, conversation_history: list, intent: str) -> str:
    """Apply safety guardrails to generated reply."""
    reply_text = _strip_redundant_criteria_ask(reply_text, conversation_history or [])
    return reply_text


def _strip_redundant_criteria_ask(reply_text: str, conversation_history: list) -> str:
    """Remove 'me falta saber: X' style phrases if user already provided that criteria."""
    ask_patterns = [
        (re.compile(r'me falta saber\s*:?\s*', re.I), ''),
        (re.compile(r'falta\s+saber\s*:?\s*', re.I), ''),
        (re.compile(r'decime\s+(?:cuan[dt]os?|cu[aá]n?to)\s+', re.I), ''),
    ]
    recent_user_text = ' '.join(
        msg.get('body', '') for msg in conversation_history[-3:]
        if not msg.get('fromMe', True)
    ).lower()

    for pattern, replacement in ask_patterns:
        if pattern.search(recent_user_text):
            stripped = pattern.sub(replacement, reply_text)
            if stripped != reply_text and stripped.strip():
                reply_text = stripped

    return reply_text


# ==================== MAIN ORCHESTRATOR ====================

DUNOD_COMPANY_ID = 7
DUNOD_RENT_REQUIREMENTS = (
    "Claro, te cuento los requisitos principales para alquilar con nosotros:\n"
    "• Tener ingresos comprobables.\n"
    "• Abonar el primer mes de alquiler y el depósito.\n"
    "• Deberá ofrecer al menos dos de las siguientes categorías de garantías:\n"
    "  a) Título de propiedad inmueble.\n"
    "  b) Garantía de fianza; o fiador solidario (Locativa, Celsus).\n"
    "  c) Garantía personal del locatario (ingresos). En caso de ser más de un locatario, pueden sumarse los ingresos de cada uno de ellos.\n\n"
)


class ConversationOrchestrator:
    """
    Main orchestrator for AI agent conversations.

    Usage:
        orchestrator = ConversationOrchestrator(company_id=1, conversation_id=123, contact_id=456)
        result = await orchestrator.orchestrate(text="...", conversation_history=[...])
    """

    def __init__(
        self,
        company_id: int = None,
        conversation_id: Optional[int] = None,
        contact_id: Optional[int] = None,
        conversation_state: str = "new",
        previous_slots: dict = None,
        phone_number: str = "",
    ):
        if company_id is None or int(company_id) <= 0:
            raise ValueError("company_id is required (multi-tenant safety)")
        self.company_id = company_id
        self.conversation_id = conversation_id
        self.contact_id = contact_id
        self.phone_number = phone_number or ''
        # Coerce to string (API may pass dict/None from old clients)
        if not isinstance(conversation_state, str) or not conversation_state:
            self.conversation_state = "new"
        else:
            self.conversation_state = _coerce_state(conversation_state)
        self.openai_client = get_openai_client()
        self.ai_config = get_ai_agent_config(company_id)
        # Detect fine-tuned model for short prompt path
        self._model = self.ai_config.get('model', 'gpt-4o-mini')
        self.is_fine_tuned = self._model.startswith('ft:')
        self._db = None
        self._turn_start_ms = 0

        # Runtime data - seed with previous slots for accumulation across turns
        self.slots: dict = dict(previous_slots or {})
        self.intent: Optional[str] = None
        self.tool_calls: list = []
        self.citations: list = []
        self.used_fallback = False

    def _get_db(self) -> Session:
        if self._db is None:
            from app.core.db import SessionLocal as _SL
            self._db = _SL()
            self._db_owned = True
        return self._db

    def _close_db(self) -> None:
        if self._db is not None and getattr(self, "_db_owned", False):
            try:
                self._db.close()
            except Exception:
                pass
            self._db = None
            self._db_owned = False

    async def orchestrate(
        self,
        text: str,
        conversation_history: list = None,
    ) -> dict:
        """
        Main orchestration entry point.

        Full flow per turn:
        1. Extract slots from user message
        2. Classify intent
        3. Determine next state
        4. Build system prompt with KB context
        5. Call LLM with function calling
        6. Execute tools if needed
        7. Second LLM call with results
        8. Apply guardrails
        9. Persist traces (ai_turns, ai_tool_calls, ai_conversations)
        10. Return result
        """
        self._turn_start_ms = time_module.time() * 1000
        conversation_history = conversation_history or []

        try:
            # Step 1: Extract slots from current message and merge with previous slots
            current_slots = extract_slots(text, self.company_id, tenant_config=self.ai_config)
            # Classify intent EARLY so downstream gates (rent_req_prepend etc.) can see it
            self.intent = classify_intent(text, self.conversation_state)["intent"]
            # 'Con qué info filtrás?' / '¿Qué criterios usás?' → explain current slots, don't re-search
            _ef_pat = re.compile(r'(con qu[eé] (info|datos|criterio|filtro)|qu[eé] (info|datos|criterio|filtro)s? (us[aá]s|ten[eé]s|filtr)|c[oó]mo (filtr|buscas|busc[aá]s)|filtras con qu[eé]|qu[eé] estoy buscando)', re.IGNORECASE)
            if _ef_pat.search(text or ''):
                self.intent = 'explain_filters'
                self._explain_filters_requested = True
            else:
                self._explain_filters_requested = False
            # Context override: if last bot message offered a visit and user replies affirmatively,
            # route to schedule_appointment (prevents "si" from being mis-classified or ignored).
            try:
                _last_bot = ""
                for _m in reversed(conversation_history or []):
                    if (_m.get("role") == "assistant") and (_m.get("content") or "").strip():
                        _last_bot = (_m.get("content") or "").lower()
                        break
                _aff_tokens = {"si", "sí", "dale", "ok", "okay", "claro", "perfecto",
                               "obvio", "bueno", "listo", "va", "si dale", "sí dale",
                               "si porfa", "si por favor", "me interesa", "quiero", "quiero coordinar"}
                _txt_norm = (text or "").strip().lower().rstrip("!.?¿¡")
                _visit_offered = ("coordinemos una visita" in _last_bot) or ("coordinamos una visita" in _last_bot) or ("agendar una visita" in _last_bot) or ("coordinar una visita" in _last_bot)
                if _visit_offered and (_txt_norm in _aff_tokens or any(_txt_norm.startswith(t + " ") for t in _aff_tokens)):
                    self.intent = "schedule_appointment"
            except Exception:
                pass
            # Merge: current message overrides previous, but keep previous if not in current
            # Remove false-positive phone matches from budget numbers
            if "phone" in current_slots:
                phone_val = str(current_slots["phone"])
                budget_val = str((current_slots.get("budget") or {}).get("value", ""))
                if phone_val == budget_val or len(phone_val) > 13:
                    del current_slots["phone"]

            # Snapshot search criteria BEFORE merge to detect changes
            _pre_budget = (self.slots.get('budget') or {}).get('value')
            _pre_budget_min = self.slots.get('budget_min')
            _pre_zone = self.slots.get('zone')
            _pre_ptype = self.slots.get('property_type')
            _pre_rooms = self.slots.get('rooms')
            _pre_operation = self.slots.get('operation')

            for key, val in current_slots.items():
                # rooms=0 is the extractor's "remove bedroom filter" signal:
                # drop the slot entirely instead of storing a falsy 0 that the
                # property filter would silently skip over.
                if key == 'rooms' and val == 0:
                    self.slots.pop('rooms', None)
                    continue
                self.slots[key] = val  # current message takes priority

            # Backfill budget currency from operation (rent→ARS, sale→USD) if missing
            _b_post = self.slots.get('budget')
            if isinstance(_b_post, dict) and not _b_post.get('currency'):
                _op_for_cur = self.slots.get('operation')
                if _op_for_cur == 'rent':
                    _b_post['currency'] = 'ARS'
                elif _op_for_cur == 'sale':
                    _b_post['currency'] = 'USD'

            # Operation flip (sale↔rent): wipe currency-dependent slots + cache
            _post_op_now = self.slots.get('operation')
            if _pre_operation and _post_op_now and _pre_operation != _post_op_now:
                self.slots.pop('budget', None)
                self.slots.pop('budget_min', None)
                self.slots.pop('_results_cache', None)
                self.slots.pop('_results_offset', None)
                self.slots.pop('_results_exhausted', None)
                self.slots.pop('_rent_req_sent', None)  # allow Dunod prepend to re-fire if sale→rent
                self._op_flipped = True
                print(f'[orchestrator] Operation flipped {_pre_operation}→{_post_op_now}: cleared budget+cache')
            else:
                self._op_flipped = False

            # Dunod rent requirements: first transition to operation='rent' → prepend requisitos
            # Skip prepend for intents that are not search-related
            _skip_prepend_intents = ('knowledge_query', 'contact_info', 'goodbye', 'schedule_appointment', 'not_interested')
            if (
                self.company_id == DUNOD_COMPANY_ID
                and self.slots.get('operation') == 'rent'
                and _pre_operation != 'rent'
                and not self.slots.get('_rent_req_sent')
                and getattr(self, 'intent', None) not in _skip_prepend_intents
            ):
                self.slots['_rent_req_sent'] = True
                self._rent_req_prepend = True
            else:
                self._rent_req_prepend = False

            # Auto-upsert contact when new name or email is captured from this message
            _new_name = current_slots.get('name')
            _new_email = current_slots.get('email')
            if (_new_name or _new_email) and self.phone_number:
                try:
                    _db_au = self._get_db()
                    _au_number = re.sub(r'\D', '', self.phone_number)
                    _au_existing = _db_au.execute(
                        text('SELECT id FROM contacts WHERE "companyId" = :cid AND number = :num LIMIT 1'),
                        {"cid": self.company_id, "num": _au_number}
                    ).mappings().first()
                    if _au_existing:
                        _db_au.execute(
                            text('UPDATE contacts SET name = COALESCE(:name, name), email = COALESCE(:email, email), "updatedAt" = NOW() WHERE id = :id'),
                            {"id": _au_existing["id"], "name": _new_name, "email": _new_email}
                        )
                        _db_au.commit()
                        print(f'[auto_upsert] Updated contact {_au_existing["id"]}: name={_new_name} email={_new_email}')
                except Exception as _e:
                    print(f'[auto_upsert] Error: {_e}')

            # If any search-relevant criterion changed while a cache is active, invalidate it
            _post_budget = (self.slots.get('budget') or {}).get('value')
            _post_budget_min = self.slots.get('budget_min')
            _post_zone = self.slots.get('zone')
            _post_ptype = self.slots.get('property_type')
            _post_rooms = self.slots.get('rooms')
            _criteria_changed = (
                _post_budget != _pre_budget or _post_budget_min != _pre_budget_min or
                _post_zone != _pre_zone or _post_ptype != _pre_ptype or _post_rooms != _pre_rooms
            )
            if _criteria_changed and (self.slots.get('_results_cache') or self.slots.get('_results_exhausted')):
                self.slots.pop('_results_cache', None)
                self.slots.pop('_results_offset', None)
                self.slots.pop('_results_exhausted', None)
                print(f'[orchestrator] Search criteria changed, cache invalidated for fresh search')

            # Step 2: Classify intent
            intent_result = classify_intent(text, self.conversation_state)
            self.intent = intent_result["intent"]

            # Step 3: State transition
            self.conversation_state = compute_next_state(
                self.conversation_state, self.intent, self.slots
            )

            # Step 3.5: Short-circuit for first greeting - use configured welcome_msg
            # Also treat confirmations as more_results if cache is available
            if intent_result.get("action") == "continue_conversation" and self.slots.get("_results_cache"):
                offset = int(self.slots.get("_results_offset") or 0)
                if offset < len(self.slots["_results_cache"]):
                    intent_result = {"intent": "more_results", "confidence": 0.9, "action": "show_more_results"}
                    self.intent = "more_results"

            # Clear exhausted flag when user explicitly asks for a new property search
            if intent_result.get("action") == "collect_slots_or_search":
                self.slots.pop('_results_exhausted', None)

            # Step 3.7: Handle "not interested" after showing properties
            _had_shown_results = self.slots.get('_results_exhausted') or bool(self.slots.get('_results_cache'))
            if self.intent == 'not_interested' and _had_shown_results:
                self.slots.pop('_results_cache', None)
                self.slots.pop('_results_offset', None)
                self.slots.pop('_results_exhausted', None)
                _zone = self.slots.get('zone', '')
                _ptype = self.slots.get('property_type', '')
                _b = self.slots.get('budget') or {}
                _budget = _b.get('value', '')
                _bcur = _b.get('currency') or ('ARS' if self.slots.get('operation') == 'rent' else 'USD')
                _ptype_es = {'apartment': 'depto', 'house': 'casa', 'office': 'oficina', 'land': 'terreno', 'local': 'local', 'ph': 'PH'}.get(str(_ptype), _ptype) if _ptype else ''
                _criteria = []
                if _zone: _criteria.append(f"zona {_zone}")
                if _ptype_es: _criteria.append(_ptype_es)
                if _budget:
                    try:
                        _criteria.append(f"hasta {_bcur} {int(_budget):,}")
                    except Exception:
                        _criteria.append(f"hasta {_bcur} {_budget}")
                _ctx = f" con {' + '.join(_criteria)}" if _criteria else ""
                reply = f"Entendido, esas no eran lo que buscabas{_ctx}. ¿Querés que amplíe la zona, ajuste el presupuesto, o cambiás el tipo de propiedad?"
                await self._persist_traces(user_text=text, reply=reply, conversation_history=conversation_history, db=self._get_db())
                return {
                    "reply": reply, "model": "intent_handler",
                    "intent": self.intent, "conversation_state": self.conversation_state,
                    "slots": self.slots, "tool_calls": [], "citations": [],
                    "used_fallback": False, "latency_ms": 0, "toolCallCount": 0,
                }

            # Off-hours notice: configured business hours + offhours_msg.
            # Sent once per conversation (slot flag), then the bot keeps
            # helping normally so the lead is never left without answers.
            if (
                not self.slots.get('_offhours_sent')
                and self.ai_config.get('offhours_msg', '').strip()
                and _is_outside_business_hours(self.ai_config.get('business_hours') or {})
            ):
                self.slots['_offhours_sent'] = True
                _off_msg = self.ai_config['offhours_msg'].strip()
                await self._persist_traces(
                    user_text=text, reply=_off_msg,
                    conversation_history=conversation_history, db=self._get_db()
                )
                return {
                    "reply": _off_msg, "model": "offhours_msg",
                    "intent": self.intent, "conversation_state": self.conversation_state,
                    "slots": self.slots, "tool_calls": [], "citations": [],
                    "used_fallback": False, "latency_ms": 0, "toolCallCount": 0,
                }

            # Farewell: configured farewell_msg answers goodbyes directly
            if self.intent == 'goodbye' and self.ai_config.get('farewell_msg', '').strip():
                _bye_msg = self.ai_config['farewell_msg'].strip()
                await self._persist_traces(
                    user_text=text, reply=_bye_msg,
                    conversation_history=conversation_history, db=self._get_db()
                )
                return {
                    "reply": _bye_msg, "model": "farewell_msg",
                    "intent": self.intent, "conversation_state": self.conversation_state,
                    "slots": self.slots, "tool_calls": [], "citations": [],
                    "used_fallback": False, "latency_ms": 0, "toolCallCount": 0,
                }

            if intent_result.get("action") == "welcome":
                welcome = self.ai_config.get("welcome_msg", "").strip()
                if welcome:
                    await self._persist_traces(
                        user_text=text, reply=welcome,
                        conversation_history=conversation_history, db=self._get_db()
                    )
                    return {
                        "reply": welcome,
                        "model": "welcome_msg",
                        "intent": self.intent,
                        "conversation_state": self.conversation_state,
                        "slots": self.slots,
                        "tool_calls": [],
                        "citations": [],
                        "used_fallback": False,
                        "latency_ms": 0,
                        "toolCallCount": 0,
                    }

            # Short-circuit: explain_filters — summarize active search slots
            if getattr(self, '_explain_filters_requested', False):
                _s = self.slots
                _op_txt = {'rent': 'alquiler', 'sale': 'venta', 'tasacion': 'tasación'}.get(_s.get('operation'), 'búsqueda')
                _pt_txt = {'apartment': 'depto', 'house': 'casa', 'office': 'oficina', 'land': 'terreno', 'local': 'local', 'ph': 'PH'}.get(_s.get('property_type'))
                _b = _s.get('budget') or {}
                _bv = _b.get('value')
                _bc = _b.get('currency') or ('ARS' if _s.get('operation') == 'rent' else 'USD')
                _parts = []
                _parts.append(f"Operación: {_op_txt}")
                if _pt_txt: _parts.append(f"Tipo: {_pt_txt}")
                if _s.get('zone'): _parts.append(f"Zona: {_s['zone']}")
                if _bv: _parts.append(f"Presupuesto hasta {_bc} {int(_bv):,}")
                if _s.get('rooms'): _parts.append(f"Ambientes: {_s['rooms']} o más")
                _summary = "Actualmente estoy filtrando con:\n• " + "\n• ".join(_parts) if _parts else "Todavía no tengo filtros activos."
                _summary += "\n\n¿Qué te gustaría cambiar? (zona, presupuesto, ambientes, tipo)"
                await self._persist_traces(user_text=text, reply=_summary,
                    conversation_history=conversation_history, db=self._get_db())
                return {
                    'reply': _summary, 'model': 'explain_filters',
                    'intent': self.intent, 'conversation_state': self.conversation_state,
                    'slots': self.slots, 'tool_calls': [], 'citations': [],
                    'used_fallback': False, 'latency_ms': 0, 'toolCallCount': 0,
                    'followup': '',
                }

            # Short-circuit: operation flip + no budget yet → ask for new budget before searching
            if getattr(self, '_op_flipped', False) and not (self.slots.get('budget') or {}).get('value'):
                _op2 = self.slots.get('operation')
                _op_lbl = 'alquilar' if _op2 == 'rent' else ('comprar' if _op2 == 'sale' else 'tu nueva búsqueda')
                _cur_hint = 'en pesos' if _op2 == 'rent' else 'en dólares'
                _ask = f"Dale, cambiamos a {_op_lbl}. ¿Qué presupuesto máximo tenés {_cur_hint}? También decime zona si querés ajustarla."
                await self._persist_traces(user_text=text, reply=_ask,
                    conversation_history=conversation_history, db=self._get_db())
                return {
                    'reply': _ask, 'model': 'op_flip_ask',
                    'intent': 'property_search', 'conversation_state': self.conversation_state,
                    'slots': self.slots, 'tool_calls': [], 'citations': [],
                    'used_fallback': False, 'latency_ms': 0, 'toolCallCount': 0,
                    'followup': '',
                }

            # Step 3.5: Short-circuit for 'resend last results' from cache
            # Re-render the LAST shown batch (cache[offset - last_batch_size : offset]).
            # Doesn't advance offset.
            if intent_result.get('action') == 'resend_last_results':
                cache = self.slots.get('_results_cache') or []
                offset = int(self.slots.get('_results_offset') or 0)
                if cache and offset > 0:
                    # Show the last batch of up to 5 (the most recently shown)
                    last_batch_start = max(0, offset - 5)
                    batch = cache[last_batch_start:offset]
                    rendered = _render_property_results(batch, limit=5)
                    followup = '¿Te interesa alguna de estas? Si querés coordinamos una visita.'
                    await self._persist_traces(user_text=text, reply=rendered,
                        conversation_history=conversation_history, db=self._get_db())
                    return {
                        'reply': rendered, 'model': 'cache_resend',
                        'intent': self.intent, 'conversation_state': self.conversation_state,
                        'slots': self.slots, 'tool_calls': [], 'citations': [],
                        'used_fallback': False, 'latency_ms': 0, 'toolCallCount': 0,
                        'followup': followup, 'from_cache': True,
                    }
                # No cache: fall through to search logic by downgrading to property_search
                intent_result = {"intent": "property_search", "confidence": 0.7, "action": "collect_slots_or_search"}

            # Step 3.6: Short-circuit for 'show more results' from cache
            if intent_result.get('action') == 'show_more_results':
                cache = self.slots.get('_results_cache') or []
                offset = int(self.slots.get('_results_offset') or 0)
                print(f'[cache_path] cache_len={len(cache)} offset={offset}')
                if cache and offset < len(cache):
                    batch = cache[offset:offset + 5]
                    self.slots['_results_offset'] = offset + len(batch)
                    rendered = _render_property_results(batch, limit=5)
                    remaining = len(cache) - self.slots['_results_offset']
                    if remaining <= 0:
                        self.slots.pop('_results_cache', None)
                        self.slots.pop('_results_offset', None)
                        self.slots['_results_exhausted'] = True  # Prevent forced re-search
                        followup = '¿Alguna de estas te interesa o querés que coordinemos una visita? Si no, podemos ampliar zona, presupuesto u otro criterio 🏡'
                    else:
                        followup = f'Tengo {remaining} opción{"es" if remaining != 1 else ""} más. ¿Querés verlas, coordinar una visita o alguna de estas ya te interesa?'
                    await self._persist_traces(user_text=text, reply=rendered,
                        conversation_history=conversation_history, db=self._get_db())
                    return {
                        'reply': rendered, 'model': 'cache',
                        'intent': self.intent, 'conversation_state': self.conversation_state,
                        'slots': self.slots, 'tool_calls': [], 'citations': [],
                        'used_fallback': False, 'latency_ms': 0, 'toolCallCount': 0,
                        'followup': followup, 'from_cache': True,
                    }

            # Step 4: Build system prompt
            system_prompt = self._build_system_prompt(conversation_history)

            # Step 5: Build messages
            messages = self._build_messages(text, conversation_history, system_prompt)

            # Step 6: First LLM call
            if not self.openai_client or not settings.openai_api_key:
                return self._fallback_reply("Lo siento, el servicio de IA no está disponible.")

            # When results are exhausted, remove search_properties so LLM can't re-trigger the loop.
            # The exhausted flag is cleared by collect_slots_or_search when the user starts a new search.
            # Per-agent disabled_tools: list of tool names to exclude (e.g. [agendar_cita])
            _disabled_tools = set(self.ai_config.get("disabled_tools") or [])
            _available_tools = [
                f for f in FUNCTIONS
                if f["function"]["name"] not in _disabled_tools
                and not (f["function"]["name"] == "search_properties" and self.slots.get("_results_exhausted"))
            ]

            _call_model = self._model
            try:
                response = self.openai_client.chat.completions.create(
                    model=_call_model,
                    messages=messages,
                    tools=_available_tools,
                    tool_choice="auto",
                    **_tokens_kwarg(self._model, self.ai_config.get("max_tokens", 1000)),
                    **_temperature_kwarg(self._model, self.ai_config.get("temperature", 0.3)),
                )
            except Exception as _ft_err:
                _base = self.ai_config.get("base_model", "gpt-4o-mini")
                if self.is_fine_tuned and _base != _call_model:
                    print(f"[orchestrator] FT model error ({type(_ft_err).__name__}), falling back to {_base}")
                    self._model = _base
                    self.is_fine_tuned = False
                    response = self.openai_client.chat.completions.create(
                        model=_base,
                        messages=messages,
                        tools=_available_tools,
                        tool_choice="auto",
                        **_tokens_kwarg(self._model, self.ai_config.get("max_tokens", 1000)),
                        **_temperature_kwarg(self._model, self.ai_config.get("temperature", 0.3)),
                    )
                else:
                    raise

            response_message = response.choices[0].message
            reply_text = response_message.content or ""
            tool_calls = response_message.tool_calls or []

            # Step 7: Execute tools
            db = self._get_db()
            if tool_calls:
                for tc in tool_calls:
                    function_name = tc.function.name
                    try:
                        function_args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                    except json.JSONDecodeError:
                        function_args = {}

                    if function_name == "search_properties":
                        function_args = _enrich_search_args(function_args, self.slots)
                    tool_result = await execute_tool(
                        tool_name=function_name,
                        tool_args=function_args,
                        company_id=self.company_id,
                        db=db,
                    )

                    self.tool_calls.append({
                        "tool": function_name,
                        "args": function_args,
                        "result": tool_result,
                        "success": tool_result.get("ok", False),
                    })
                    # Sync upsert_contact data back to slots for subsequent turns
                    if function_name == "upsert_contact" and tool_result.get("ok"):
                        if function_args.get("name"):
                            self.slots["name"] = function_args["name"]
                        if function_args.get("email"):
                            self.slots["email"] = function_args["email"]

                    messages.append({
                        "role": "assistant",
                        "content": reply_text,
                        "tool_calls": [{"id": tc.id, "type": "function",
                                        "function": {"name": function_name, "arguments": tc.function.arguments}}]
                    })
                    # For search_properties, pass only a count summary to LLM.
                    # Full rendering is done deterministically by _force_property_results_reply.
                    if function_name == "search_properties":
                        _cnt = len((tool_result.get("results") or []))
                        _tool_content = f"Búsqueda completada. Se encontraron {_cnt} propiedades. El sistema las presentará al usuario automáticamente." if tool_result.get("ok") else json.dumps(tool_result, ensure_ascii=False)
                    else:
                        _tool_content = json.dumps(tool_result, ensure_ascii=False)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": _tool_content,
                    })

                # Guard: if search_properties was called but budget is missing, intercept
                _search_tc_names = [tc.function.name for tc in tool_calls]
                _has_search = "search_properties" in _search_tc_names
                _has_budget = bool((self.slots.get("budget") or {}).get("value"))
                # Also check if the LLM passed price_max in the search args (trust it)
                if _has_search and not _has_budget:
                    for _tc in tool_calls:
                        if _tc.function.name == "search_properties":
                            try:
                                _args = json.loads(_tc.function.arguments or "{}")
                                if _args.get("price_max"):
                                    self.slots["budget"] = {"value": int(_args["price_max"]), "direction": "max"}
                                    _has_budget = True
                            except Exception:
                                pass
                if _has_search and not _has_budget:
                    # Clear tool calls so results are not shown, ask for budget
                    self.tool_calls = []
                    _ask_cur_q = 'en pesos' if self.slots.get('operation') == 'rent' else 'en USD'
                    return {
                        "reply": f"¿Cuál es tu presupuesto máximo {_ask_cur_q}?",
                        "model": self._model,
                        "intent": self.intent,
                        "conversation_state": self.conversation_state,
                        "slots": self.slots,
                        "tool_calls": [],
                        "citations": self.citations,
                        "used_fallback": False,
                        "latency_ms": 0,
                        "toolCallCount": 0,
                    }

                # Second LLM call — skip if all tool calls are property searches
                # (those replies get overwritten by _force_property_results_reply anyway)
                _all_search = all(tc.function.name == "search_properties" for tc in tool_calls)
                if _all_search:
                    reply_text = ""  # let _force_property_results_reply render deterministically
                else:
                    response2 = self.openai_client.chat.completions.create(
                        model=self._model,
                        messages=messages,
                        **_tokens_kwarg(self._model, self.ai_config.get("max_tokens", 1000)),
                        **_temperature_kwarg(self._model, self.ai_config.get("temperature", 0.7)),
                    )
                    reply_text = response2.choices[0].message.content or reply_text

            # Step 7.5: Ensure at least one successful deterministic property search exists.
            budget = (self.slots.get("budget") or {}).get("value")
            budget_min = self.slots.get("budget_min")
            zone = self.slots.get("zone")
            ptype = self.slots.get("property_type")
            def _search_matches_current(tc: dict) -> bool:
                if tc.get("tool") != "search_properties":
                    return False
                args = tc.get("args") or {}
                a_zone = _normalize_text(args.get("location"))
                a_type = _canonical_property_type(args.get("property_type"))
                a_budget = _safe_int(args.get("price_max"), 0)
                a_budget_min = _safe_int(args.get("price_min"), 0)
                c_budget = _safe_int(budget, 0)
                c_budget_min = _safe_int(budget_min, 0)
                zone_ok = (not zone) or (a_zone == _normalize_text(zone))
                type_ok = (not ptype) or (a_type == _canonical_property_type(ptype))
                budget_ok = (not c_budget) or (a_budget == c_budget)
                # If user set a minimum price, search must also filter by it
                budget_min_ok = (not c_budget_min) or (a_budget_min == c_budget_min)
                return zone_ok and type_ok and budget_ok and budget_min_ok

            has_matching_successful_search = any(
                _search_matches_current(tc)
                and tc.get("result", {}).get("ok")
                and (tc.get("result", {}).get("results") or [])
                for tc in (self.tool_calls or [])
            )
            # Only force-search when we have meaningful filters (avoids premature search)
            _enough_filters = bool(zone) and bool(budget) and bool(ptype)
            # Skip forced search if all results were already shown (prevents infinite loop)
            _results_exhausted = self.slots.get('_results_exhausted', False)
            # Skip forced search if user is browsing an active cache (prevents re-search on interest/confirmation)
            _has_active_cache = bool(self.slots.get('_results_cache'))
            if _enough_filters and not has_matching_successful_search and not _results_exhausted and not _has_active_cache:
                forced_args = {
                    "location": zone,
                    "property_type": ptype,
                    "price_max": budget,
                    "price_min": self.slots.get("budget_min"),
                    "rooms": self.slots.get("rooms"),
                }
                forced_args = _enrich_search_args(forced_args, self.slots)
                forced_result = await execute_tool(
                    tool_name="search_properties",
                    tool_args=forced_args,
                    company_id=self.company_id,
                    db=db,
                )
                self.tool_calls.append({
                    "tool": "search_properties",
                    "args": forced_args,
                    "result": forced_result,
                    "success": forced_result.get("ok", False),
                })
                results = forced_result.get("results") or []
                if not results:
                    # Build a helpful no-results message with the applied filters
                    filters = []
                    if zone: filters.append(f"zona {zone}")
                    if ptype: filters.append(ptype)
                    if budget:
                        _bcur_fs = (self.slots.get('budget') or {}).get('currency') or ('ARS' if self.slots.get('operation') == 'rent' else 'USD')
                        filters.append(f"hasta {_bcur_fs} {budget:,}")
                    filter_desc = " + ".join(filters) if filters else "los criterios indicados"
                    reply_text = f"No encontré propiedades con {filter_desc}. ¿Querés que amplíe la zona o ajuste el presupuesto?"

            # Step 8: Deterministic fallback for property search when tool returned results
            reply_text = self._force_property_results_reply(reply_text)

            # Strip Markdown link syntax — WhatsApp doesn't render it, shows raw brackets
            import re as _re
            reply_text = _re.sub(r'\[([^\]]+)\]\((https?://[^\)]+)\)', r'', reply_text)

            # Apply guardrails
            reply_text = apply_guardrails(reply_text, conversation_history, self.intent)

            # Prepend Dunod rent requirements on first rent-intent turn
            if getattr(self, '_rent_req_prepend', False):
                # Soften LLM's typical "¡Genial!"/"¡Perfecto!" opener — redundant after requisitos
                _rt = (reply_text or "").lstrip()
                def _lower_next(m):
                    _nxt = m.group(2) or ""
                    return "Ahora, " + (_nxt[:1].lower() + _nxt[1:] if _nxt else "")
                _rt = re.sub(r'^(¡?\s*(?:Genial|Perfecto|Excelente|Buen[íi]simo|Dale|Ok)\s*!?\s*)(\S*)', _lower_next, _rt, count=1, flags=re.IGNORECASE)
                reply_text = DUNOD_RENT_REQUIREMENTS + _rt

            # Step 9: Fallback if empty
            if not reply_text or not reply_text.strip():
                reply_text = "Gracias por tu mensaje. ¿Hay algo específico en lo que pueda ayudarte?"
                self.used_fallback = True

            # Step 10: Persist traces
            await self._persist_traces(user_text=text, reply=reply_text, conversation_history=conversation_history, db=db)

            latency_ms = time_module.time() * 1000 - self._turn_start_ms

            # Ensure followup is always sent when properties are shown
            _followup = getattr(self, "_followup_msg", "")
            if not _followup and "Te paso opciones concretas:" in reply_text:
                _followup = "¿Alguna de estas te interesa o querés que coordinemos una visita? Si no, podemos ampliar zona, presupuesto u otro criterio 🏡"

            return {
                "reply": reply_text,
                "model": response.model,
                "intent": self.intent,
                "conversation_state": self.conversation_state,
                "slots": self.slots,
                "tool_calls": self.tool_calls,
                "citations": self.citations,
                "used_fallback": self.used_fallback,
                "latency_ms": round(latency_ms, 1),
                "toolCallCount": len(self.tool_calls),
                "followup": _followup,
            }

        except Exception as e:
            print(f"[orchestrator] Error: {e}")
            return self._fallback_reply(f"Lo siento, hubo un error: {str(e)[:100]}")

    def _build_system_prompt(self, conversation_history: list) -> str:
        """Build system prompt with persona + KB + conversation context."""

        # Fine-tuned model: use minimal prompt (personality is baked into weights)
        if self.is_fine_tuned:
            ft_prompt = self.ai_config.get("ft_system_prompt", "").strip()
            if ft_prompt:
                slots_json = json.dumps(self.slots, ensure_ascii=False) if self.slots else "{}"
                return ft_prompt.format(
                    conversation_state=self.conversation_state,
                    slots_json=slots_json,
                )
            return f"Estado: {self.conversation_state} | Datos: {json.dumps(self.slots, ensure_ascii=False)}"

        persona = self.ai_config.get("persona", "").strip()

        # KB context using hybrid RAG
        kb_text = ""
        try:
            last_msg = ""
            for msg in reversed(conversation_history):
                if not msg.get("fromMe", True):
                    last_msg = msg.get('body', msg.get('content', ''))
                    break
            if last_msg:
                kb_text, self.citations = get_kb_context_for_prompt(
                    query=last_msg,
                    company_id=self.company_id,
                    max_chars=3000,
                    top_k=5,
                )
        except Exception as e:
            print(f"[orchestrator] KB context error: {e}")

        # Get per-company name and email from DB (multi-niche support).
        # Uses the orchestrator's managed SQLAlchemy session instead of opening
        # a raw psycopg2 connection per LLM call (no pooling, leaked errors).
        _co_name = COMPANY_PROFILE.get('name', 'Empresa')
        _co_email = COMPANY_PROFILE.get('email', '')
        try:
            _co_row = self._get_db().execute(
                text('SELECT name, email FROM companies WHERE id = :cid LIMIT 1'),
                {"cid": self.company_id},
            ).mappings().first()
            if _co_row:
                _co_name = _co_row['name'] or _co_name
                _co_email = _co_row['email'] or _co_email
        except Exception as _co_err:
            print(f"[orchestrator] company info lookup failed (company_id={self.company_id}): {_co_err}")
        company_info = f"""INFORMACIÓN DE LA EMPRESA:
- Nombre: {_co_name}
- Email: {_co_email}
- Horario: {self.ai_config.get('business_hours', '') or COMPANY_PROFILE.get('hours_human', '')}
"""

        _has_active_cache = bool(self.slots.get('_results_cache'))
        _results_exhausted = self.slots.get('_results_exhausted', False)
        _has_name = bool(self.slots.get('name'))
        _has_phone = bool(self.slots.get('phone'))
        _has_email = bool(self.slots.get('email'))

        # Build a clean slots display (hide internal pagination keys)
        _visible_slots = {k: v for k, v in self.slots.items() if not k.startswith('_')}
        # Inject contact metadata so LLM can call upsert_contact / agendar_cita
        if self.phone_number:
            _visible_slots['whatsapp_number'] = self.phone_number
        if self.contact_id:
            _visible_slots['contact_id'] = self.contact_id
        slots_info = (chr(10) + "DATOS DEL CLIENTE: " + json.dumps(_visible_slots, ensure_ascii=False) + chr(10)) if _visible_slots else ""
        state_info = f"\nESTADO: {self.conversation_state.upper()}\n"
        # Rent context: steer budget question to pesos
        if (_visible_slots.get("operation") == "rent"):
            state_info += "NOTA OPERACIÓN: El cliente quiere ALQUILAR. Cuando pidas presupuesto, pedilo mensual en pesos (ARS), no en dólares.\n"
        # Prepend armed: requirements will be auto-inserted, don't duplicate
        if getattr(self, "_rent_req_prepend", False):
            state_info += "NOTA PREPEND: Los requisitos de alquiler se agregarán automáticamente al inicio de tu respuesta. NO los repitas. Procedé con el flujo normal: si tenés TIPO+ZONA+PRESUPUESTO, llamá search_properties; si falta algo, pedí solo lo que falte.\n"

        # Intent context — tell LLM exactly what situation it's handling
        _intent_ctx = ""
        if self.intent == 'property_interest':
            _intent_ctx = "\nSITUACIÓN ACTUAL: El usuario acaba de mostrar interés en una propiedad específica.\n"
        elif _has_active_cache:
            _intent_ctx = "\nSITUACIÓN ACTUAL: Se están mostrando propiedades al usuario. No busques de nuevo.\n"
        elif _results_exhausted:
            _intent_ctx = "\nSITUACIÓN ACTUAL: Ya se mostraron todas las propiedades disponibles.\n"

        # Persona is the identity — put it first and frame it explicitly
        identity = persona if persona else "Sos un asistente virtual de una empresa."
        if persona and len(persona) < 200:
            identity = f"IDENTIDAD:\n{persona}\nActuá siempre con esta personalidad en cada respuesta."

        # Contact collection hint
        _contact_hint = ""
        if not _has_name:
            _contact_hint = "- Todavía no tenés el nombre del cliente. En cuanto haya una oportunidad natural, pedíselo.\n"

        from datetime import datetime as _dt_now, timedelta as _td_now
        _today_str = _dt_now.now().strftime('%Y-%m-%d')
        _tomorrow_str = (_dt_now.now() + _td_now(days=1)).strftime('%Y-%m-%d')
        _weekday_es = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'][_dt_now.now().weekday()]
        instrucciones = f"""
FECHA ACTUAL: hoy es {_weekday_es} {_today_str}. Mañana es {_tomorrow_str}.
Al llamar agendar_cita usá SIEMPRE starts_at con año {_dt_now.now().year} o posterior (formato ISO YYYY-MM-DDTHH:MM:SS). NUNCA uses fechas de años anteriores.

INSTRUCCIONES (WhatsApp):
- Mensajes cortos y directos. Solo una pregunta o propuesta por turno.
- SIEMPRE terminá tu respuesta con una propuesta concreta o siguiente paso. Nunca dejes la conversación abierta.
- Sos un asesor inmobiliario proactivo: tu objetivo es avanzar hacia la visita o el cierre, no solo informar.

BÚSQUEDA DE PROPIEDADES:
- REGLA CRITICA: NO uses search_properties hasta tener los 3 datos: 1) TIPO, 2) ZONA, 3) PRESUPUESTO MÁXIMO (en USD para compra, en ARS para alquiler).
- NUNCA vuelvas a preguntar datos que ya figuran en DATOS DEL CLIENTE. Si operation, property_type, zone, budget o rooms ya están seteados, no los repreguntes — usá el valor y pedí solo lo que falte.
- Si operation="rent" ya está seteada, el cliente quiere ALQUILAR; NO preguntes si quiere comprar, alquilar o tasar.
- Si property_type ya está seteado, NO preguntes qué tipo de propiedad busca.
- Pasá `currency` en search_properties: "ARS" si operation="rent" y el presupuesto está en pesos, "USD" en caso contrario.
- Si el cliente dio un rango (ej: "de 300k a 450k"), pasá price_min Y price_max en la búsqueda.
- Cuando tenés los 3 datos, buscá inmediatamente.
- Si ya se mostraron propiedades (hay cache activo o resultados agotados), NO vuelvas a buscar.
- SIEMPRE pasá operation_type: si los DATOS DEL CLIENTE tienen operation="rent" usá "rent", si tienen operation="sale" usá "sale". Por defecto "sale".

CUANDO EL USUARIO MUESTRA INTERÉS EN UNA PROPIEDAD:
- Ofrecé coordinar una visita de inmediato: "¿Coordinamos una visita para que la puedas ver?"
- Si no tenés su nombre, pedíselo para agendar: "¿Me decís tu nombre para reservar el turno?"
- Si ya tenés nombre, ofrecé fechas o pedí disponibilidad horaria.
- Nunca respondas solo con información sin proponer el siguiente paso.

CUANDO EL USUARIO DICE QUE NO LE INTERESA NINGUNA:
- Ofrecé ajustar criterios: zona, presupuesto o tipo de propiedad.
- Preguntá qué no le convenció para mejorar la búsqueda.

PROPUESTAS PROGRESIVAS (en orden de avance):
1. Mostrá propiedades
2. Preguntá si alguna le interesa
3. Ofrecé visita
4. Pedí datos de contacto (nombre, horario disponible)
5. Confirmá el turno

DATOS DE CONTACTO:
{_contact_hint}- Si el usuario está listo para visitar, pedí nombre y disponibilidad horaria.
- Cuando el cliente diga su nombre o email, llamá upsert_contact con whatsapp_number (ya está en DATOS DEL CLIENTE) + el dato nuevo.
- Para agendar_cita usá el contact_id que está en DATOS DEL CLIENTE.

BASE DE CONOCIMIENTO:
- Si el cliente pregunta algo sobre la empresa (redes, horario, dirección, comisiones, procedimientos, etc.), PRIMERO revisá la sección BASE DE CONOCIMIENTO de este prompt.
- Si no está en BASE DE CONOCIMIENTO, usá la herramienta consultar_kb antes de responder.
- NUNCA inventes datos de la empresa que no estén en la KB.

- Responder siempre en español rioplatense.
- NUNCA uses formato Markdown: no uses [texto](url), no uses **negrita**, no uses _cursiva_. Solo texto plano.
"""


        # Per-agent: override visit instructions if agendar_cita disabled
        _agent_disabled = set(self.ai_config.get("disabled_tools") or [])
        if "agendar_cita" in _agent_disabled:
            _ov_lines = [
                "OVERRIDE CRITICO: ESTE AGENTE NO AGENDA VISITAS.",
                "IGNORA toda instruccion previa sobre visitas, citas, turnos y agendar_cita.",
                "NUNCA ofrezcas visita ni preguntes disponibilidad horaria.",
                "Cuando el usuario muestre interes: confirma propiedades, pedi nombre,",
                "luego envia el mensaje de cierre de tu IDENTIDAD/PERSONA. Nada mas.",
            ]
            instrucciones = instrucciones + chr(10) + chr(10) + chr(10).join(_ov_lines) + chr(10)

        prompt_parts = [
            identity,
            company_info,
            f"\nBASE DE CONOCIMIENTO:\n{kb_text}\n" if kb_text else "",
            slots_info,
            state_info,
            _intent_ctx,
            instrucciones,
        ]

        return "\n".join(filter(None, prompt_parts))

    def _build_messages(self, text: str, conversation_history: list, system_prompt: str) -> list[dict]:
        """Build message list for LLM."""
        messages = [{"role": "system", "content": system_prompt}]

        if conversation_history:
            for msg in conversation_history[-10:]:
                role = "user" if not msg.get("fromMe", True) else "assistant"
                content = msg.get('body', msg.get('content', ''))
                if content and not content.startswith("["):
                    messages.append({"role": role, "content": content})

        messages.append({"role": "user", "content": text})
        return messages

    def _force_property_results_reply(self, reply_text: str) -> str:
        """Deterministic render from current-turn search results.
        Prefers search call matching current extracted filters to avoid cross-intent leakage.
        """
        search_calls = [
            tc for tc in (self.tool_calls or [])
            if tc.get('tool') == 'search_properties' and tc.get('result', {}).get('ok')
        ]
        print(f'[force_reply] search_calls={len(search_calls)} tool_calls={len(self.tool_calls or [])}')
        if not search_calls:
            return reply_text

        current_zone = _normalize_text(self.slots.get('zone'))
        current_type = _canonical_property_type(self.slots.get('property_type'))
        current_budget_min = _safe_int(self.slots.get('budget_min'), 0)

        def _score(tc: dict) -> int:
            args = tc.get('args') or {}
            a_zone = _normalize_text(args.get('location'))
            a_type = _canonical_property_type(args.get('property_type'))
            a_price_min = _safe_int(args.get('price_min'), 0)
            score = 0
            if current_type and a_type == current_type:
                score += 3
            if current_zone and a_zone == current_zone:
                score += 2
            if (not current_type) and (not current_zone):
                score += 1
            # Prefer calls that correctly applied price_min filter
            if current_budget_min and a_price_min == current_budget_min:
                score += 2
            return score

        # Pick the call that best matches current filters (avoid leakage from prior topic)
        selected_call = sorted(search_calls, key=_score)[-1]

        selected_payload = selected_call.get('result', {})
        normalized = _dedupe_properties(_normalize_search_results(selected_payload))

        # If selected current-intent search has 0 results, force clean no-results text.
        if not normalized:
            ptype = self.slots.get('property_type') or 'propiedades'
            type_es = {
                'house': 'casas', 'apartment': 'departamentos', 'land': 'terrenos',
                'store': 'locales', 'office': 'oficinas', 'ph': 'PH'
            }.get(str(ptype), 'propiedades')
            zone = self.slots.get('zone') or 'la zona solicitada'
            _b_slot_ns = self.slots.get('budget') or {}
            budget = _b_slot_ns.get('value')
            _bcur_ns = _b_slot_ns.get('currency') or ('ARS' if self.slots.get('operation') == 'rent' else 'USD')
            budget_txt = f" hasta {_bcur_ns} {budget:,}" if budget else ""
            return f"No encontré {type_es} en {zone}{budget_txt} con los filtros actuales. Si querés, amplío zona o presupuesto y vuelvo a buscar."

        if not normalized:
            return reply_text

        meta = selected_payload.get('meta') if isinstance(selected_payload, dict) else {}
        _tokko_log("render", count=len(normalized), meta=meta)
        fallback_used = (meta or {}).get("fallback_used", False)
        strategies = (meta or {}).get("strategies", [])
        type_relaxed = (meta or {}).get("type_relaxed", False)
        requested_type_meta = (meta or {}).get("requested_type", "")
        req_zone = ((meta or {}).get("requested") or {}).get("location")
        prefix = ""
        req_rooms = (meta.get("requested") or {}).get("rooms") if meta else None
        type_names_es = {
            'house': 'casas', 'apartment': 'departamentos', 'land': 'terrenos',
            'store': 'locales', 'office': 'oficinas', 'ph': 'PH'
        }
        req_type_es = type_names_es.get(str(requested_type_meta), requested_type_meta) if requested_type_meta else ""
        # No-fallback policy: ask user to change filters rather than showing
        # relaxed/alternative results the user didn't ask for.
        if fallback_used:
            req_budget = ((meta or {}).get("requested") or {}).get("budget")
            budget_val = None
            if isinstance(req_budget, dict):
                budget_val = req_budget.get("value")
            elif isinstance(req_budget, (int, float)):
                budget_val = req_budget
            parts = []
            if req_type_es:
                parts.append(req_type_es)
            if req_rooms:
                parts.append(f"de {req_rooms} o más amb.")
            if req_zone:
                parts.append(f"en {req_zone}")
            if budget_val:
                try:
                    _bcur_fb = (req_budget.get('currency') if isinstance(req_budget, dict) else None) or (self.slots.get('budget') or {}).get('currency') or ('ARS' if self.slots.get('operation') == 'rent' else 'USD')
                    parts.append(f"hasta {_bcur_fb} {int(budget_val):,}")
                except Exception:
                    pass
            criteria = " ".join(parts) if parts else "con esos criterios"
            # Clear cache so next search is fresh
            self.slots.pop('_results_cache', None)
            self.slots.pop('_results_offset', None)
            self.slots['_results_exhausted'] = False
            self._followup_msg = None
            return (
                f"No encontré propiedades {criteria} en este momento. "
                f"¿Querés ajustar algún criterio? Podemos cambiar zona, presupuesto, "
                f"tipo de propiedad o cantidad de ambientes."
            )
        if fallback_used and type_relaxed and req_type_es and req_zone:
            prefix = f"No encontré {req_type_es} en {req_zone} con ese presupuesto. Te muestro otras opciones disponibles en la zona: "
        elif fallback_used and type_relaxed and req_type_es:
            prefix = f"No encontré {req_type_es} con ese presupuesto. Te muestro otras opciones disponibles: "
        elif fallback_used and "relax_rooms" in strategies and req_rooms and req_zone:
            prefix = f"No encontré propiedades de {req_rooms} ambientes en {req_zone} con ese presupuesto. Te muestro las opciones disponibles en esa zona: "
        elif fallback_used and "relax_rooms" in strategies and req_rooms:
            prefix = f"No encontré propiedades de {req_rooms} ambientes con ese presupuesto. Te muestro las opciones disponibles: "
        elif fallback_used and "relax_location" in strategies and req_zone:
            prefix = f"No tenemos propiedades en {req_zone} por el momento. Te muestro opciones de nuestra cartera: "
        raw = _render_property_results(normalized, limit=5)
        if prefix:
            # Strip redundant generic intro when we have a custom prefix
            raw = raw.replace("Te paso opciones concretas: ", "")
        # Save paginated cache for follow-up requests
        self.slots['_results_cache'] = normalized
        self.slots['_results_offset'] = 5
        remaining = len(normalized) - 5
        if remaining > 10:
            # Too many extras: offer to narrow search instead of blind pagination
            self._followup_msg = (
                f'Tengo {remaining} opciones más. ¿Querés que hagamos la búsqueda más específica para achicar los resultados? '
                f'Podemos ajustar zona, ambientes o rango de precio.'
            )
        elif remaining > 0:
            self._followup_msg = f'Tengo {remaining} opción{"es" if remaining != 1 else ""} más. ¿Querés verlas, coordinar una visita o alguna de estas ya te interesa?'
        else:
            self._followup_msg = '¿Alguna de estas te interesa o querés que coordinemos una visita? Si no, podemos ampliar zona, presupuesto u otro criterio 🏡'
        return prefix + raw

    async def _persist_traces(
        self,
        user_text: str,
        reply: str,
        conversation_history: list,
        db: Session,
    ) -> None:
        """Persist turn traces to ai_turns, ai_tool_calls, ai_conversations."""
        latency_ms = round(time_module.time() * 1000 - self._turn_start_ms, 1)
        tokens_in = len(json.dumps({"text": user_text, "history": conversation_history[-10:]})) // 4
        tokens_out = len(reply) // 4

        try:
            # Try to create tables if they don't exist (best-effort)
            try:
                db.execute(text("""
                    CREATE TABLE IF NOT EXISTS ai_conversations (
                        id SERIAL PRIMARY KEY,
                        company_id INTEGER NOT NULL,
                        contact_id INTEGER,
                        state VARCHAR(30) NOT NULL DEFAULT 'new',
                        intent VARCHAR(60),
                        slots_json TEXT DEFAULT '{}',
                        messages_count INTEGER NOT NULL DEFAULT 0,
                        summary TEXT,
                        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
                    )"""))
                db.execute(text("""
                    CREATE TABLE IF NOT EXISTS ai_tool_calls (
                        id SERIAL PRIMARY KEY,
                        conversation_id INTEGER,
                        turn_role VARCHAR(20) DEFAULT 'assistant',
                        tool_name VARCHAR(60) NOT NULL,
                        tool_args_json TEXT DEFAULT '{}',
                        tool_result_json TEXT DEFAULT '{}',
                        success BOOLEAN NOT NULL DEFAULT true,
                        error_message TEXT,
                        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
                    )"""))
                # Add missing columns to ai_turns if needed
                for col_def in [
                    ("intent", "VARCHAR(60)"),
                    ("latency_ms", "DECIMAL(10,2) DEFAULT 0"),
                    ("citations_json", "TEXT DEFAULT '[]'"),
                    ("tokens_in", "INTEGER DEFAULT 0"),
                    ("tokens_out", "INTEGER DEFAULT 0"),
                ]:
                    try:
                        db.execute(text(f"ALTER TABLE ai_turns ADD COLUMN IF NOT EXISTS {col_def[0]} {col_def[1]}"))
                    except Exception:
                        pass  # Column already exists
            except Exception as e:
                print(f"[orchestrator] Table setup (optional): {e}")

            # Update or create ai_conversations
            conv_data = {
                "company_id": self.company_id,
                "contact_id": self.contact_id,
                "state": self.conversation_state,
                "slots_json": json.dumps(self.slots, ensure_ascii=False),
                "intent": self.intent,
            }

            if self.conversation_id:
                db.execute(
                    text("""UPDATE ai_conversations
                        SET state = :state, slots_json = :slots_json, intent = :intent,
                            messages_count = messages_count + 1, updated_at = NOW()
                        WHERE id = :id"""),
                    {"id": self.conversation_id, **conv_data}
                )
            else:
                row = db.execute(
                    text("""INSERT INTO ai_conversations
                        (company_id, contact_id, state, slots_json, intent, messages_count, created_at, updated_at)
                        VALUES (:company_id, :contact_id, :state, :slots_json, :intent, 1, NOW(), NOW())
                        RETURNING id"""),
                    conv_data
                ).mappings().first()
                if row:
                    self.conversation_id = row["id"]

            # Insert ai_turn (user turn)
            if self.conversation_id:
                db.execute(
                    text("""INSERT INTO ai_turns
                        (conversation_id, role, content, model, intent, latency_ms, tokens_in, tokens_out,
                         citations_json, created_at, updated_at)
                        VALUES (:conversation_id, 'user', :content, :model, :intent, :latency_ms,
                                :tokens_in, :tokens_out, :citations_json, NOW(), NOW())"""),
                    {
                        "conversation_id": self.conversation_id,
                        "content": user_text,
                        "model": self._model,
                        "intent": self.intent,
                        "latency_ms": latency_ms,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "citations_json": json.dumps(self.citations, ensure_ascii=False),
                    }
                )

                # Insert assistant turn
                db.execute(
                    text("""INSERT INTO ai_turns
                        (conversation_id, role, content, model, intent, latency_ms, tokens_in, tokens_out,
                         citations_json, created_at, updated_at)
                        VALUES (:conversation_id, 'assistant', :content, :model, :intent, :latency_ms,
                                :tokens_in, :tokens_out, :citations_json, NOW(), NOW())"""),
                    {
                        "conversation_id": self.conversation_id,
                        "content": reply,
                        "model": self._model,
                        "intent": self.intent,
                        "latency_ms": latency_ms,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "citations_json": json.dumps(self.citations, ensure_ascii=False),
                    }
                )

                # Insert tool calls
                for tc in self.tool_calls:
                    db.execute(
                        text("""INSERT INTO ai_tool_calls
                            (conversation_id, turn_role, tool_name, tool_args_json, tool_result_json,
                             success, error_message, created_at, updated_at)
                            VALUES (:conversation_id, 'assistant', :tool_name, :tool_args_json,
                                    :tool_result_json, :success, :error_message, NOW(), NOW())"""),
                        {
                            "conversation_id": self.conversation_id,
                            "tool_name": tc["tool"],
                            "tool_args_json": json.dumps(tc["args"], ensure_ascii=False),
                            "tool_result_json": json.dumps(tc["result"], ensure_ascii=False),
                            "success": tc["success"],
                            "error_message": tc["result"].get("error", "") if isinstance(tc["result"], dict) else "",
                        }
                    )

            # CRM enrichment: lead_score, leadStatus, needs, ai_decision_logs
            try:
                self._persist_crm_enrichment(db, user_text=user_text, reply=reply)
            except Exception as _e_crm:
                print(f"[orchestrator] CRM enrichment failed: {_e_crm}")

            db.commit()
        except Exception as e:
            print(f"[orchestrator] Failed to persist traces: {e}")
            try:
                db.rollback()
            except Exception:
                pass



    def _persist_crm_enrichment(self, db, user_text: str, reply: str) -> None:
        """Per-turn CRM enrichment: score, status, needs summary, decision log.

        Derived from slots + user text. Independent of LLM tool calls — always runs.
        """
        if not self.contact_id:
            return
        try:
            from app.api.v1.endpoints._ai_shared import _score_from_text, _infer_lead_status_by_signals
        except Exception:
            return

        existing = db.execute(
            text('SELECT lead_score, "leadStatus", needs FROM contacts WHERE id = :cid AND "companyId" = :company LIMIT 1'),
            {"cid": self.contact_id, "company": self.company_id},
        ).mappings().first()
        if not existing:
            return

        cur_score = float(existing.get("lead_score") or 0)
        cur_status = str(existing.get("leadStatus") or "")

        combined_text = (user_text or "")
        if reply:
            combined_text = combined_text + " " + (reply or "")

        new_score = _score_from_text(combined_text, cur_score)
        new_status = _infer_lead_status_by_signals(combined_text, new_score, cur_status)

        # Build `needs` summary from slots (overwrites each turn — always current snapshot)
        _s = self.slots or {}
        _op_txt = {"rent": "alquiler", "sale": "compra", "tasacion": "tasación"}.get(_s.get("operation"), "búsqueda")
        _pt_txt = {"apartment": "depto", "house": "casa", "office": "oficina", "land": "terreno", "local": "local", "ph": "PH"}.get(_s.get("property_type"), "")
        _b = _s.get("budget") or {}
        _bv = _b.get("value")
        _bc = _b.get("currency") or ("ARS" if _s.get("operation") == "rent" else "USD")
        _parts = [f"op:{_op_txt}"]
        if _pt_txt: _parts.append(f"tipo:{_pt_txt}")
        if _s.get("zone"): _parts.append(f"zona:{_s['zone']}")
        if _bv:
            try: _parts.append(f"ppto:{_bc} {int(_bv):,}")
            except Exception: pass
        if _s.get("budget_min"):
            try: _parts.append(f"min:{_bc} {int(_s['budget_min']):,}")
            except Exception: pass
        if _s.get("rooms"): _parts.append(f"amb:{_s['rooms']}+")
        needs_summary = " | ".join(_parts)

        db.execute(
            text('UPDATE contacts SET lead_score = :score, "leadStatus" = :status, needs = :needs, "updatedAt" = NOW() WHERE id = :cid AND "companyId" = :company'),
            {"score": int(round(new_score)), "status": new_status, "needs": needs_summary[:900],
             "cid": self.contact_id, "company": self.company_id},
        )

        # Sync the pipeline stage to match the inferred lead status (board reflects agent progress)
        try:
            _sync_stage_from_status(db, self.company_id, self.contact_id, new_status)
        except Exception:
            pass

        # Find an associated ticket for ai_decision_logs (required not null)
        ticket_row = db.execute(
            text('SELECT id FROM tickets WHERE "contactId" = :cid AND "companyId" = :company ORDER BY id DESC LIMIT 1'),
            {"cid": self.contact_id, "company": self.company_id},
        ).mappings().first()
        ticket_id = int(ticket_row["id"]) if ticket_row else 0

        # Build reason + preview for the trace
        _slot_short = {k: v for k, v in _s.items() if not str(k).startswith("_")}
        _reason_obj = {
            "intent": self.intent,
            "state": self.conversation_state,
            "slots": _slot_short,
            "score": int(round(new_score)),
            "status": new_status,
            "tools": [tc.get("tool") for tc in (self.tool_calls or [])],
        }
        preview = (reply or "")[:280]
        guardrail = "prepend_rent_req" if getattr(self, "_rent_req_prepend", False) else (
            "op_flip_wipe" if getattr(self, "_op_flipped", False) else (
            "explain_filters" if getattr(self, "_explain_filters_requested", False) else ""))

        if ticket_id:
            db.execute(
                text("""INSERT INTO ai_decision_logs
                        (company_id, ticket_id, conversation_type, decision_key, reason, guardrail_action, response_preview, created_at)
                        VALUES (:company, :ticket, :ctype, :dkey, :reason, :guardrail, :preview, NOW())"""),
                {
                    "company": self.company_id,
                    "ticket": ticket_id,
                    "ctype": "whatsapp",
                    "dkey": str(self.intent or "unknown")[:80],
                    "reason": json.dumps(_reason_obj, ensure_ascii=False, default=str)[:4000],
                    "guardrail": guardrail[:80] if guardrail else None,
                    "preview": preview,
                },
            )

    def _fallback_reply(self, message: str) -> dict:
        return {
            "reply": message,
            "model": "error",
            "intent": self.intent or "error",
            "conversation_state": self.conversation_state,
            "slots": self.slots,
            "tool_calls": [],
            "citations": [],
            "used_fallback": True,
            "latency_ms": 0,
            "toolCallCount": 0,
        }


# ==================== CONVENIENCE FUNCTIONS ====================

async def orchestrate_reply(
    text: str,
    conversation_history: list = None,
    company_id: int = None,
    conversation_id: int = None,
    contact_id: int = None,
    conversation_state: str = "new",
    previous_slots: dict = None,
    phone_number: str = "",
) -> dict:
    """
    Convenience function that wraps ConversationOrchestrator.
    Maintains backwards compatibility with generate_reply() interface.
    """
    if company_id is None or int(company_id) <= 0:
        raise ValueError("company_id is required (multi-tenant safety)")
    orchestrator = ConversationOrchestrator(
        company_id=company_id,
        conversation_id=conversation_id,
        contact_id=contact_id,
        conversation_state=conversation_state,
        previous_slots=previous_slots or {},
        phone_number=phone_number,
    )
    try:
        return await orchestrator.orchestrate(text=text, conversation_history=conversation_history)
    finally:
        orchestrator._close_db()
