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

from app.core.config import settings
from app.core.db import get_db
from app.services.knowledge_base import get_ai_agent_config, get_kb_documents, COMPANY_PROFILE, SOCIAL_MEDIA
from app.services.rag_service import RAGService, get_kb_context_for_prompt


# ==================== OPENAI CLIENT ====================

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
                    "property_type": {"type": "string", "description": "Tipo: 'apartment', 'house', 'store', 'office', 'land'"},
                    "rooms": {"type": "integer", "description": "Cantidad de ambientes/dormitorios"},
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

def extract_slots(text: str, company_id: int = 1) -> dict:
    """Extract structured information (slots) from user message."""
    text_lower = text.lower()
    slots = {}

    # Budget extraction
    budget_patterns = [
        (r'hasta\s*(?:us[d\$]?\s*)?(\d{1,3}(?:[.,]\d{3})*)', 'max'),
        (r'maxim[oa]\s*(?:us[d\$]?\s*)?(\d{1,3}(?:[.,]\d{3})*)', 'max'),
        (r'(?:presupuesto|rango)\s*(?:de\s*)?(?:us[d\$]?\s*)?(\d{1,3}(?:[.,]\d{3})*)', 'max'),
        (r'(\d{1,3}(?:[.,]\d{3})*)\s*(?:us[d\$]|d[oó]lares?|dolares)', 'max'),
        (r'(\d{1,3}(?:[.,]\d{3})*)\s*(?:luc|mil)', 'max'),
    ]
    for pattern, direction in budget_patterns:
        match = re.search(pattern, text_lower)
        if match:
            value = re.sub(r'[.,]', '', match.group(1))
            try:
                budget = int(value)
                if budget < 1000 and budget > 10:
                    budget = budget * 1000
                elif budget < 10:
                    budget = budget * 100000
                slots['budget'] = {"value": budget, "direction": direction}
                break
            except ValueError:
                pass

    # Zone extraction
    zone_keywords = [
        'palermo', 'belgrano', 'recoleta', 'caballito', 'villa crespo', 'almagro', 'barracas',
        'barrio norte', 'centro', 'microcentro', 'nunez', 'saavedra', 'las cañitas',
        'villa urquiza', 'coghlan', 'urquiza', 'paternal', 'villa del parque', 'velez sarsfield',
        'flores', 'carapachay', 'munro', 'olivos', 'la lucila', 'martinez', 'acassuso',
        'san isidro', 'beccar', 'victorica', 'pilar', 'escobar', 'tigre', 'nordelta',
        'rosario', 'cordoba', 'mendoza', 'buenos aires', 'cap federal', 'capital federal',
    ]
    for zone in zone_keywords:
        if zone in text_lower:
            slots['zone'] = zone.title()
            break

    # Property type
    type_map = {
        'departamento': 'apartment', 'depto': 'apartment',
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

    return slots


# ==================== INTENT CLASSIFICATION ====================

def classify_intent(text: str, conversation_state: str = "new") -> dict:
    """Classify user intent using keyword matching + context."""
    text_lower = text.lower().strip()

    if any(k in text_lower for k in ['chau', 'nos vemos', 'hasta luego', 'adiós']):
        return {"intent": "goodbye", "confidence": 0.95, "action": "close_conversation"}

    if any(k in text_lower for k in ['hola', 'buenas', 'hi', 'hello', 'buen día', 'buenos días']):
        action = "welcome" if conversation_state == "new" else "continue"
        return {"intent": "greeting", "confidence": 0.95, "action": action}

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

    if any(k in text_lower for k in ['sí', 'si', 'correcto', 'dale', 'perfecto', 'ok', 'sí, dale']):
        return {"intent": "confirmation", "confidence": 0.8, "action": "continue_conversation"}

    objection_signals = ['muy caro', 'caro', 'no puedo', 'fuera de presupuesto',
                         'no me conviene', 'demasiado']
    if any(k in text_lower for k in objection_signals):
        return {"intent": "objection", "confidence": 0.85, "action": "handle_objection"}

    return {"intent": "general", "confidence": 0.5, "action": "general_response"}


# ==================== STATE MACHINE ====================

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
    return transitions.get((current_state, intent), current_state)


# ==================== TOOL EXECUTORS ====================

async def execute_tool(
    tool_name: str,
    tool_args: dict,
    company_id: int = 1,
    db: Session = None,
) -> dict:
    """Execute a tool and return results."""
    import httpx

    if tool_name == "search_properties":
        try:
            tokko_url = settings.tokko_api_url or "https://api.tokkobroker.com/api/v1"
            params = {"key": settings.tokko_api_key, "limit": 20}
            async with httpx.AsyncClient() as client:
                response = await client.get(f"{tokko_url}/property/", params=params, timeout=15)
            if response.status_code == 200:
                data = response.json()
                properties = data.get("objects", [])[:20]
                results = []
                for p in properties:
                    photo = ""
                    if p.get("photos") and len(p["photos"]) > 0:
                        photo = p["photos"][0].get("image", "")
                    price = "Consultar"
                    if p.get("operations"):
                        for op in p["operations"]:
                            for price_info in op.get("prices", []):
                                price_val = price_info.get('price', 0)
                                price = f"USD {price_val:,}" if price_val else "Consultar"
                                break
                    location = "Argentina"
                    if p.get("location"):
                        location = p["location"].get("full_location", "Argentina")
                    results.append({
                        "id": p.get("id", 0),
                        "title": p.get("address", "Propiedad"),
                        "price": price,
                        "location": location,
                        "type": p.get("type", "property"),
                        "url": f"https://tokkobroker.com/property/{p.get('id', '')}",
                        "photo": photo,
                        "rooms": p.get("bedroom_amount", p.get("rooms", "")),
                        "bathrooms": p.get("bathroom_amount", ""),
                        "area": p.get("livable_area", ""),
                    })
                return {"ok": True, "results": results}
            return {"ok": False, "error": f"Tokko API error: {response.status_code}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    elif tool_name == "get_company_info":
        return {
            "ok": True,
            "results": {
                "name": COMPANY_PROFILE.get("name", ""),
                "services": COMPANY_PROFILE.get("services", []),
                "email": COMPANY_PROFILE.get("email", ""),
                "whatsapp_phone": COMPANY_PROFILE.get("whatsapp_phone", ""),
                "hours": COMPANY_PROFILE.get("hours_human", ""),
                "instagram": SOCIAL_MEDIA.get("instagram_handle", ""),
                "facebook": SOCIAL_MEDIA.get("facebook_name", ""),
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
                    text('UPDATE contacts SET name = COALESCE(:name, name), email = COALESCE(:email, email), "updatedAt" = NOW() WHERE id = :id'),
                    {"id": existing["id"], "name": tool_args.get("name"), "email": tool_args.get("email")}
                )
                contact_id = existing["id"]
            else:
                row = db.execute(
                    text('INSERT INTO contacts (name, number, email, isGroup, "companyId", lead_score, createdAt, "updatedAt") VALUES (:name, :number, :email, false, :companyId, 0, NOW(), NOW()) RETURNING id'),
                    {"name": tool_args.get("name") or number, "number": number, "email": tool_args.get("email") or "", "companyId": company_id}
                ).mappings().first()
                contact_id = row["id"] if row else None
            db.commit()
            return {"ok": True, "contact_id": contact_id}
        except Exception as e:
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
            return {"ok": True, "appointment": dict(row) if row else None}
        except Exception as e:
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

class ConversationOrchestrator:
    """
    Main orchestrator for AI agent conversations.

    Usage:
        orchestrator = ConversationOrchestrator(company_id=1, conversation_id=123, contact_id=456)
        result = await orchestrator.orchestrate(text="...", conversation_history=[...])
    """

    def __init__(
        self,
        company_id: int = 1,
        conversation_id: Optional[int] = None,
        contact_id: Optional[int] = None,
        conversation_state: str = "new",
    ):
        self.company_id = company_id
        self.conversation_id = conversation_id
        self.contact_id = contact_id
        self.conversation_state = conversation_state
        self.openai_client = get_openai_client()
        self.ai_config = get_ai_agent_config(company_id)
        self._db = None
        self._turn_start_ms = 0

        # Runtime data
        self.slots: dict = {}
        self.intent: Optional[str] = None
        self.tool_calls: list = []
        self.citations: list = []
        self.used_fallback = False

    def _get_db(self) -> Session:
        if self._db is None:
            db_gen = get_db()
            self._db = next(db_gen)
        return self._db

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
            # Step 1: Extract slots
            self.slots = extract_slots(text, self.company_id)

            # Step 2: Classify intent
            intent_result = classify_intent(text, self.conversation_state)
            self.intent = intent_result["intent"]

            # Step 3: State transition
            self.conversation_state = compute_next_state(
                self.conversation_state, self.intent, self.slots
            )

            # Step 4: Build system prompt
            system_prompt = self._build_system_prompt(conversation_history)

            # Step 5: Build messages
            messages = self._build_messages(text, conversation_history, system_prompt)

            # Step 6: First LLM call
            if not self.openai_client or not settings.openai_api_key:
                return self._fallback_reply("Lo siento, el servicio de IA no está disponible.")

            response = self.openai_client.chat.completions.create(
                model=self.ai_config.get("model", "gpt-4o-mini"),
                messages=messages,
                tools=FUNCTIONS,
                tool_choice="auto",
                max_tokens=self.ai_config.get("max_tokens", 1000),
                temperature=self.ai_config.get("temperature", 0.3),
            )

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

                    messages.append({
                        "role": "assistant",
                        "content": reply_text,
                        "tool_calls": [{"id": tc.id, "type": "function",
                                        "function": {"name": function_name, "arguments": tc.function.arguments}}]
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(tool_result, ensure_ascii=False),
                    })

                # Second LLM call
                response2 = self.openai_client.chat.completions.create(
                    model=self.ai_config.get("model", "gpt-4o-mini"),
                    messages=messages,
                    max_tokens=self.ai_config.get("max_tokens", 1000),
                    temperature=self.ai_config.get("temperature", 0.7),
                )
                reply_text = response2.choices[0].message.content or reply_text

            # Step 8: Apply guardrails
            reply_text = apply_guardrails(reply_text, conversation_history, self.intent)

            # Step 9: Fallback if empty
            if not reply_text or not reply_text.strip():
                reply_text = "Gracias por tu mensaje. ¿Hay algo específico en lo que pueda ayudarte?"
                self.used_fallback = True

            # Step 10: Persist traces
            await self._persist_traces(text=text, reply=reply_text, conversation_history=conversation_history, db=db)

            latency_ms = time_module.time() * 1000 - self._turn_start_ms

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
            }

        except Exception as e:
            print(f"[orchestrator] Error: {e}")
            return self._fallback_reply(f"Lo siento, hubo un error: {str(e)[:100]}")

    def _build_system_prompt(self, conversation_history: list) -> str:
        """Build system prompt with persona + KB + conversation context."""
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

        company_info = f"""INFORMACIÓN DE LA EMPRESA:
- Nombre: {COMPANY_PROFILE.get('name', 'Empresa')}
- Servicios: {', '.join(COMPANY_PROFILE.get('services', []))}
- Email: {COMPANY_PROFILE.get('email', '')}
- WhatsApp: {COMPANY_PROFILE.get('whatsapp_phone', '')}
- Horario: {COMPANY_PROFILE.get('hours_human', '')}
- Instagram: {SOCIAL_MEDIA.get('instagram_handle', '')}
"""

        slots_info = f"\nDATOS RECOLECTADOS: {json.dumps(self.slots, ensure_ascii=False)}\n" if self.slots else ""
        state_info = f"\nESTADO: {self.conversation_state.upper()}\n"

        prompt_parts = [
            persona if persona else "Sos un asistente virtual de una empresa.",
            company_info,
            f"\nBASE DE CONOCIMIENTO:\n{kb_text}\n" if kb_text else "\n(Sin base de conocimiento)\n",
            slots_info,
            state_info,
            "\nREGLAS DE RESPUESTA (WhatsApp):\n- Mensajes cortos y directos\n- Solo una pregunta por turno\n- Confirmar comprensión\n- Dar siempre siguiente acción clara\n- Usar herramientas obligatoriamente\n",
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

    async def _persist_traces(
        self,
        text: str,
        reply: str,
        conversation_history: list,
        db: Session,
    ) -> None:
        """Persist turn traces to ai_turns, ai_tool_calls, ai_conversations."""
        latency_ms = round(time_module.time() * 1000 - self._turn_start_ms, 1)
        tokens_in = len(json.dumps({"text": text, "history": conversation_history[-10:]})) // 4
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
                        "content": text,
                        "model": self.ai_config.get("model", "gpt-4o-mini"),
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
                        "model": self.ai_config.get("model", "gpt-4o-mini"),
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

            db.commit()
        except Exception as e:
            print(f"[orchestrator] Failed to persist traces: {e}")
            try:
                db.rollback()
            except Exception:
                pass

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
    company_id: int = 1,
    conversation_id: int = None,
    contact_id: int = None,
    conversation_state: str = "new",
) -> dict:
    """
    Convenience function that wraps ConversationOrchestrator.
    Maintains backwards compatibility with generate_reply() interface.
    """
    orchestrator = ConversationOrchestrator(
        company_id=company_id,
        conversation_id=conversation_id,
        contact_id=contact_id,
        conversation_state=conversation_state,
    )
    return await orchestrator.orchestrate(text=text, conversation_history=conversation_history)
