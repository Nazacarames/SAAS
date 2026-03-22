"""
AI Agent Service - OpenAI Autonomous Agent
Uses GPT-4o with Function Calling for tool use
"""
import os
import re
import json
from typing import Optional, Dict, Any, List

from app.core.config import settings
from app.services.knowledge_base import (
    get_ai_agent_config,
    get_kb_documents,
    COMPANY_PROFILE,
    SOCIAL_MEDIA,
)
import httpx


# ==================== AGENT GUARDRAILS ====================

def _strip_redundant_criteria_ask(reply_text: str, conversation_history: list) -> str:
    """
    Remove 'me falta saber: X' style phrases from reply if user already
    provided that exact criteria in the current or recent messages.
    Ported from Node.js stripRedundantCriteriaAsk.
    """
    # Patterns that ask for criteria the user might already have given
    ask_patterns = [
        (re.compile(r'me falta saber\s*:?\s*', re.I), ''),
        (re.compile(r'falta\s+saber\s*:?\s*', re.I), ''),
        (re.compile(r'decime\s+(?:cuan[dt]os?|cu[aá]n?to)\s+', re.I), ''),
        (re.compile(r'necesito\s+saber\s*:?\s*', re.I), ''),
        (re.compile(r'cu[aá]ntos?\s+ambientes', re.I), ''),
        (re.compile(r'cu[aá]n?to\s+(?:es\s+)?el\s+presupuesto', re.I), ''),
    ]

    # Extract what user recently said (last 3 messages)
    recent_user_text = ' '.join(
        msg.get('body', '') for msg in conversation_history[-3:]
        if not msg.get('fromMe', True)
    ).lower()

    for pattern, replacement in ask_patterns:
        # Only strip if user already provided something matching
        if pattern.search(recent_user_text):
            # Check if reply still contains the criteria ask
            stripped = pattern.sub(replacement, reply_text)
            if stripped != reply_text and stripped.strip():
                reply_text = stripped

    return reply_text


def _is_price_objection(text: str) -> bool:
    """Detect if user is raising a price/cost objection"""
    text_lower = text.lower()
    objection_signals = [
        'muy caro', 'caro', 'precioso', 'exagerado', 'muy caro',
        'no puedo pagar', 'fuera de presupuesto', 'supera mi presupuesto',
        'muy expensive', 'too expensive', 'over budget', 'too pricey',
        'esta muy alto', 'esta muy cara', 'por ese precio', 'esas lucas',
        'me queda lejos', 'me conviene', 'mejor便宜的', 'mas barato'
    ]
    return any(signal in text_lower for signal in objection_signals)


def _recent_options_sent(conversation_history: list) -> bool:
    """Check if recent bot messages sent property links/options to user"""
    recent_bot = ' '.join(
        msg.get('body', '') for msg in conversation_history[-5:]
        if msg.get('fromMe', False)
    ).lower()
    return 'te paso opciones' in recent_bot or 'ficha.info' in recent_bot or 'propiedad' in recent_bot


# ==================== TOOLS (Function Calling) ====================

async def search_properties(location: str = None, price_max: int = None,
                     property_type: str = None, rooms: int = None) -> List[Dict]:
    """
    Buscar propiedades en Tokko API.
    Returns list of properties - filtering is done by the AI based on user criteria.
    """
    try:
        tokko_url = settings.tokko_api_url or "https://api.tokkobroker.com/api/v1"
        params = {
            "key": settings.tokko_api_key,
            "limit": 20,  # Get more properties, let AI filter
        }

        async with httpx.AsyncClient() as client:
            response = await client.get(f"{tokko_url}/property/", params=params, timeout=15)
        if response.status_code == 200:
            data = response.json()
            properties = data.get("objects", [])[:20]
            if properties:
                results = []
                for p in properties:
                    # Get photo
                    photo = ""
                    if p.get("photos") and len(p["photos"]) > 0:
                        photo = p["photos"][0].get("image", "")

                    # Get price from operations array
                    price = "Consultar"
                    if p.get("operations"):
                        for op in p["operations"]:
                            for price_info in op.get("prices", []):
                                price_val = price_info.get('price', 0)
                                price = f"USD {price_val:,}" if price_val else "Consultar"
                                break

                    # Get location
                    location = "Argentina"
                    if p.get("location"):
                        location = p["location"].get("full_location", "Argentina")

                    # Get property type
                    prop_type = p.get("type", "property")

                    # Get bedroom amount
                    bedrooms = p.get("bedroom_amount", p.get("rooms", ""))

                    results.append({
                        "id": p.get("id", 0),
                        "title": p.get("address", "Propiedad"),
                        "price": price,
                        "location": location,
                        "type": prop_type,
                        "url": f"https://tokkobroker.com/property/{p.get('id', '')}",
                        "photo": photo,
                        "rooms": bedrooms,
                        "bathrooms": p.get("bathroom_amount", ""),
                        "area": p.get("livable_area", ""),
                    })
                return results
        return [{"error": "No se encontraron propiedades"}]
    except Exception as e:
        return [{"error": f"Error buscando propiedades: {str(e)}"}]


def get_company_info() -> Dict:
    """Obtener información de la empresa"""
    company = COMPANY_PROFILE
    social = SOCIAL_MEDIA
    return {
        "name": company.get("name", ""),
        "services": company.get("services", []),
        "email": company.get("email", ""),
        "whatsapp_phone": company.get("whatsapp_phone", ""),
        "hours": company.get("hours_human", ""),
        "instagram": social.get("instagram_handle", ""),
        "facebook": social.get("facebook_name", ""),
        "youtube": social.get("youtube", ""),
    }


def get_knowledge_base(category: str = None) -> List[Dict]:
    """Obtener documentos de la base de conocimiento"""
    docs = get_kb_documents(1)  # company_id = 1
    if category:
        docs = [d for d in docs if d.get("category") == category]
    return docs


# ==================== OPENAI FUNCTION DEFINITIONS ====================

FUNCTIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_properties",
            "description": "Buscar propiedades en la base de datos de Tokko. USAR OBLIGATORIAMENTE cuando el usuario busque propiedades, departamentos, casas, locales, oficinas, terrenos, etc. Incluir todos los detalles que el usuario mencione (zona, precio, ambientes, características).",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "Zona o barrio (ej: 'palermo', 'belgrano', 'recoleta', 'caballito', 'villa crespo', 'centro')"
                    },
                    "price_max": {
                        "type": "integer",
                        "description": "Precio máximo en USD (ej: 200000 para USD 200,000)"
                    },
                    "property_type": {
                        "type": "string", 
                        "description": "Tipo de propiedad: 'apartment' (departamento), 'house' (casa), 'store' (local), 'office' (oficina), 'land' (terreno)"
                    },
                    "rooms": {
                        "type": "integer",
                        "description": "Cantidad de ambientes/dormitorios"
                    }
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_company_info",
            "description": "Obtener información de contacto, redes sociales y horarios de la empresa. USAR cuando el usuario pregunte por contacto, redes, Instagram, Facebook, horario, teléfono, email, etc.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_knowledge_base",
            "description": "Consultar la base de conocimiento para información sobre procedimientos, políticas, servicios, preguntas frecuentes. USAR cuando el usuario pregunte sobre cómo trabajamos, qué servicios ofrecemos, procedimientos, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Categoría específica (opcional): 'general', 'casos_uso', 'faq', 'tokko', 'procedures'"
                    }
                }
            }
        }
    }
]


# ==================== OPENAI CLIENT ====================

def get_openai_client():
    """Get or create OpenAI client"""
    try:
        from openai import OpenAI
        if settings.openai_api_key:
            return OpenAI(api_key=settings.openai_api_key)
    except Exception as e:
        print(f"Error creating OpenAI client: {e}")
    return None


# ==================== AUTONOMOUS AGENT ====================

async def generate_reply(
    text: str,
    conversation_history: list = None,
    company_name: str = None,
    company_id: int = 1
) -> dict:
    """
    Autonomous AI Agent using OpenAI GPT-4o with Function Calling.
    All instructions come from AI Agent prompt (DB) + Knowledge Base (DB).
    Tools are REQUIRED when real data is needed.
    """
    conversation_history = conversation_history or []
    
    openai_client = get_openai_client()
    if not openai_client or not settings.openai_api_key:
        return {
            "reply": "Lo siento, el servicio de IA no está disponible en este momento.",
            "model": "error",
            "usedFallback": True,
            "tokko_results": None,
            "toolCallCount": 0,
            "toolCalls": [],
        }

    try:
        # Get AI agent config from DATABASE (this contains the main prompt/persona)
        ai_config = get_ai_agent_config(company_id)
        persona = ai_config.get("persona", "").strip()
        
        # Get ALL Knowledge Base documents from DATABASE
        kb_docs = get_kb_documents(company_id)
        kb_context = ""
        if kb_docs:
            kb_context = "BASE DE CONOCIMIENTO (información del negocio - USAR SIEMPRE que el usuario pregunte sobre servicios, procedimientos, políticas):\n\n"
            for doc in kb_docs:
                kb_context += f"=== {doc['title']} ({doc.get('category', 'general')}) ===\n{doc['content']}\n\n"
        
        # Company info from hardcoded values (as backup reference)
        company_info = """INFORMACIÓN DE LA EMPRESA (USAR SIEMPRE que el usuario pregunte por contacto, horarios o redes):
- Nombre: SKYGARDEN
- Servicios: compra, venta, tasación
- Email: contacto@skygarden.com.ar
- WhatsApp: +54 9 11 3411 60103
- Horario: Lunes a Viernes 9:00 a 18:00hs
- Instagram: @skygardeninmobiliaria
- Facebook: SKYGARDEN Inmobiliaria
"""
        
        # Build conversation history
        history_str = ""
        if conversation_history:
            for msg in conversation_history[-10:]:
                role = "Usuario" if not msg.get("fromMe", False) else "Asistente"
                content = msg.get('body', msg.get('content', ''))
                history_str += f"{role}: {content}\n"
        else:
            history_str = "(primer mensaje del usuario - no hay historial)\n"
        
        # Build SYSTEM prompt - using AI Agent persona from DB as PRIMARY source
        # KB is the secondary source for business info
        system_message = f"""{persona if persona else 'Sos un asistente virtual helpful de una inmobiliaria.'}

{company_info}

{kb_context if kb_context else '(sin base de conocimiento disponible)'}

CONTEXTO DE LA CONVERSACIÓN:
{history_str}
---
USUARIO ACTUAL: {text}

REGLAS DE USO DE HERRAMIENTAS (OBLIGATORIAS):
1. **PROPIEDADES**: USA SIEMPRE search_properties cuando el usuario busque, mencione o pregunte por propiedades. NO PREGUNTES DÓNDE - BUSCÁ DIRECTO.
2. CONTACTO/HORARIOS/REDES -> USAR get_company_info  
3. SERVICIOS/PROCEDIMIENTOS/POLÍTICAS -> USAR get_knowledge_base
4. Después de search_properties, filtra y muestra las propiedades relevantes.
"""

        # Prepare messages
        messages = [
            {"role": "system", "content": system_message},
            {"role": "user", "content": text}
        ]

        # Call OpenAI with function calling - force tool use for property searches
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            tools=FUNCTIONS,
            tool_choice="auto",
            max_tokens=ai_config.get("max_tokens", 1000),
            temperature=ai_config.get("temperature", 0.3)  # Lower temp = more focused
        )

        response_message = response.choices[0].message
        reply_text = response_message.content or ""
        tool_calls = response_message.tool_calls or []
        tool_results = []
        tokko_results = None

        # Process tool calls if any
        if tool_calls:
            for tool_call in tool_calls:
                function_name = tool_call.function.name
                function_args = json.loads(tool_call.function.arguments)
                
                if function_name == "search_properties":
                    results = await search_properties(**function_args)
                    tokko_results = results
                    tool_results.append({
                        "tool": "search_properties",
                        "args": function_args,
                        "results": results
                    })
                    messages.append({
                        "role": "assistant",
                        "content": reply_text,
                        "tool_calls": [
                            {"id": tool_call.id, "type": "function", "function": {"name": function_name, "arguments": tool_call.function.arguments}}
                        ]
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(results, ensure_ascii=False)
                    })
                    
                elif function_name == "get_company_info":
                    results = get_company_info()
                    tool_results.append({
                        "tool": "get_company_info",
                        "args": function_args,
                        "results": results
                    })
                    messages.append({
                        "role": "assistant",
                        "content": reply_text,
                        "tool_calls": [
                            {"id": tool_call.id, "type": "function", "function": {"name": function_name, "arguments": tool_call.function.arguments}}
                        ]
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(results, ensure_ascii=False)
                    })
                    
                elif function_name == "get_knowledge_base":
                    results = get_knowledge_base(**function_args) if function_args.get("category") else get_knowledge_base()
                    tool_results.append({
                        "tool": "get_knowledge_base",
                        "args": function_args,
                        "results": results
                    })
                    messages.append({
                        "role": "assistant",
                        "content": reply_text,
                        "tool_calls": [
                            {"id": tool_call.id, "type": "function", "function": {"name": function_name, "arguments": tool_call.function.arguments}}
                        ]
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(results, ensure_ascii=False)
                    })

            # Second OpenAI call with tool results
            if tool_results:
                response2 = openai_client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=messages,
                    max_tokens=ai_config.get("max_tokens", 1000),
                    temperature=ai_config.get("temperature", 0.7)
                )
                reply_text = response2.choices[0].message.content or reply_text

        # ── Guardrails: strip redundant criteria asks ──────────────────────────
        reply_text = _strip_redundant_criteria_ask(reply_text, conversation_history or [])

        # ── Guardrail: price objection — don't repeat same options ─────────────
        if _is_price_objection(text) and _recent_options_sent(conversation_history or []):
            # User says it's too expensive and we recently sent options: refine instead of repeat
            refine_prompt = (
                f"El usuario está objetando por precio: '{text}'. "
                f"Historial reciente:\n{history_str}\n"
                f"Respuesta anterior del asistente incluyó opciones de propiedades. "
                f"Responde con empatía y ofrece filtrar opciones más accesibles en la misma zona. "
                f"NO repitas las mismas propiedades ya enviadas."
            )
            response_refine = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": refine_prompt}],
                max_tokens=ai_config.get("max_tokens", 800),
                temperature=0.5,
            )
            reply_text = response_refine.choices[0].message.content or reply_text

        # ── Safe fallback: if reply is empty, use general question fallback ───
        if not reply_text or not reply_text.strip():
            reply_text = "Gracias por tu mensaje. ¿Hay algo específico en lo que pueda ayudarte con tu búsqueda?"
            used_fallback = True
        else:
            used_fallback = False

        # ── Turn trace logging ───────────────────────────────────────────────
        print("[ai-agent][turn-trace]", json.dumps({
            "companyId": company_id,
            "text": text[:100],
            "replyLen": len(reply_text),
            "usedFallback": used_fallback,
            "tokkoResults": bool(tokko_results),
            "toolCallCount": len(tool_results),
            "ts": __import__("datetime").datetime.utcnow().isoformat(),
        }))

        return {
            "reply": reply_text,
            "model": response.model,
            "usedFallback": used_fallback,
            "tokko_results": tokko_results,
            "toolCallCount": len(tool_results),
            "toolCalls": tool_results,
        }

    except Exception as e:
        print(f"OpenAI Agent error: {e}")
        return {
            "reply": "Lo siento, hubo un error procesando tu mensaje. ¿Podrías repetirlo?",
            "model": "error",
            "usedFallback": True,
            "tokko_results": None,
            "toolCallCount": 0,
            "toolCalls": [],
        }


# ==================== INTENT CLASSIFIER (Legacy - for compatibility) ====================

def classify_intent(text: str) -> str:
    """Clasificador simple de intent - mantenido por compatibilidad con ai_routes.py"""
    text_lower = text.lower()
    
    GREETING_KEYWORDS = ['hola', 'buenos', 'buenas', 'hi', 'hello', 'buenas tardes', 'buenas noches', 'buen dia']
    PRICE_KEYWORDS = ['precio', 'costo', 'cuanto', 'sale', 'vale', 'presupuesto']
    RENTAL_KEYWORDS = ['alquilar', 'alquiler', 'renta']
    PROPERTY_KEYWORDS = ['buscar', 'busco', 'quiero', 'necesito', 'ver', 'propiedad', 'departamento', 'casa', 'depto']
    BYE_KEYWORDS = ['chau', 'nos vemos', 'hasta luego', 'bye']
    
    if any(b in text_lower for b in BYE_KEYWORDS):
        return "bye"
    if any(g in text_lower for g in GREETING_KEYWORDS):
        return "greeting"
    if any(p in text_lower for p in PRICE_KEYWORDS):
        return "pricing"
    if any(r in text_lower for r in RENTAL_KEYWORDS):
        return "rental"
    if any(p in text_lower for p in PROPERTY_KEYWORDS):
        return "property_search"
    
    return "general"
