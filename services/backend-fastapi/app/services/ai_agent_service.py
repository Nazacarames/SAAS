"""
AI Agent Service - FastAPI implementation
Migrated from Node.js ConversationOrchestrator
Includes both OpenAI and rule-based fallback
"""
import os
import re
from typing import Optional

from app.core.config import settings

# Initialize OpenAI client
try:
    from openai import OpenAI
    openai_client = OpenAI(api_key=settings.openai_api_key) if settings.openai_api_key else None
except Exception:
    openai_client = None

# Domain profiles
DEFAULT_DOMAIN_PROFILE = {
    "domainLabel": "negocio",
    "assistantIdentity": "asistente comercial",
    "offeringLabel": "opciones",
    "primaryObjective": "entender necesidad, resolver dudas y guiar al siguiente paso",
    "closingCta": "Si querés, avanzamos con el siguiente paso ahora.",
    "criteriaKeywords": ["busco", "quiero", "necesito", "presupuesto", "precio", "plan", "servicio", "opción", "cotización", "demo", "reunión"]
}

# Keyword patterns
CRITERIA_PATTERN = re.compile(
    r'\b(' + '|'.join(DEFAULT_DOMAIN_PROFILE["criteriaKeywords"]) + r')\b',
    re.IGNORECASE
)

# Fallback responses
FALLBACK_RESPONSES = {
    "greeting": [
        "¡Hola! Gracias por escribir. ¿En qué puedo ayudarte hoy?",
        "¡Buenos días! ¿En qué te puedo asistir?",
        "¡Hola! ¿Tenés alguna consulta sobre nuestros servicios?"
    ],
    "qualification": [
        "¡Perfecto! Contame más sobre lo que necesitás. ¿Cuál es tu presupuesto y cuándo lo necesitarías?",
        "¡Genial! Para poder ayudarte mejor, ¿podrías contarme más detalles sobre lo que buscas?",
        "¡Excelente pregunta! ¿Tenés algún plazo en mente?"
    ],
    "objection": [
        "Entiendo tu preocupación. ¿Qué sería lo más importante para vos en este caso?",
        "Totalmente válido. ¿Hay algo específico que te gustaría saber más?",
        "Te entiendo. ¿Qué información adicional te serviría para decidir?"
    ],
    "closing": [
        "¡Excelente! Te paso a un agente para continuar con el siguiente paso.",
        "¡Perfecto! Enseguida te contacto para avanzar.",
        "¡Genial! Te estaré contactando pronto."
    ],
    "general": [
        "Gracias por tu mensaje. ¿Podrías darme más detalles?",
        "Entendido. ¿Hay algo específico que te gustaría saber?",
        "Perfecto. ¿Cómo puedo ayudarte mejor?"
    ]
}

# Keyword triggers
GREETING_KEYWORDS = ['hola', 'buenos', 'buenas', 'hi', 'hello', 'como estas', 'buenas tardes', 'buenas noches']
OBJECTION_KEYWORDS = ['caro', 'muy caro', 'no quiero', 'no me sirve', 'otro', 'competencia', 'pesado', 'ningun']
CLOSING_KEYWORDS = ['si', 'ok', 'dale', 'perfecto', 'me interesa', 'quiero', 'esta bien', 'avancemos']


def detect_criteria_keywords(text: str) -> list[str]:
    """Detect qualification keywords"""
    matches = CRITERIA_PATTERN.findall(text.lower())
    return list(set(matches))


def classify_intent(text: str) -> str:
    """Classify user intent"""
    text_lower = text.lower()
    
    if any(g in text_lower for g in GREETING_KEYWORDS):
        return "greeting"
    
    if detect_criteria_keywords(text):
        return "qualification"
    
    if any(o in text_lower for o in OBJECTION_KEYWORDS):
        return "objection"
    
    if any(c in text_lower for c in CLOSING_KEYWORDS):
        return "closing"
    
    return "general"


def get_fallback_response(intent: str) -> str:
    """Get a rule-based fallback response"""
    import random
    responses = FALLBACK_RESPONSES.get(intent, FALLBACK_RESPONSES["general"])
    return random.choice(responses)


def build_system_prompt(company_name: str = "negocio") -> str:
    """Build system prompt for OpenAI"""
    return f"""Sos un asistente comercial de {company_name}.

Tu objetivo: {DEFAULT_DOMAIN_PROFILE['primaryObjective']}

Características:
- Sé amable, profesional y conversacional
- No seas demasiado formal
- Usá CTAs naturales: "{DEFAULT_DOMAIN_PROFILE['closingCta']}"

Respondé de forma clara y concisa."""


async def generate_reply(
    text: str,
    conversation_history: list = None,
    company_name: str = "negocio"
) -> dict:
    """
    Generate an AI reply - tries OpenAI, falls back to rule-based
    """
    conversation_history = conversation_history or []
    
    # Try OpenAI if available
    if openai_client and settings.openai_api_key:
        try:
            messages = [
                {"role": "system", "content": build_system_prompt(company_name)}
            ]
            
            # Add history (last 5 messages)
            for msg in conversation_history[-5:]:
                messages.append({
                    "role": "user" if not msg.get("fromMe", False) else "assistant",
                    "content": msg.get("body", "")
                })
            
            messages.append({"role": "user", "content": text})
            
            response = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                max_tokens=500,
                temperature=0.7
            )
            
            reply = response.choices[0].message.content
            return {
                "reply": reply,
                "model": response.model,
                "usedFallback": False,
                "toolCallCount": 0,
                "knowledge": []
            }
        except Exception as e:
            print(f"OpenAI error: {e}")
            # Fall through to rule-based
    
    # Use rule-based fallback
    intent = classify_intent(text)
    reply = get_fallback_response(intent)
    
    return {
        "reply": reply,
        "model": "fallback",
        "usedFallback": True,
        "intent": intent,
        "toolCallCount": 0,
        "knowledge": []
    }


async def process_incoming_message(
    db,
    contact_id: int,
    message_text: str,
    company_id: int
) -> dict:
    """Process incoming WhatsApp message through AI agent"""
    intent = classify_intent(message_text)
    
    result = await generate_reply(
        text=message_text,
        conversation_history=[],
        company_name="Charlott"
    )
    
    return {
        "intent": intent,
        "reply": result["reply"],
        "model": result["model"],
        "usedFallback": result["usedFallback"]
    }
