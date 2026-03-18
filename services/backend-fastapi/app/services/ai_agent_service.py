"""
AI Agent Service - FastAPI implementation
Migrated from Node.js ConversationOrchestrator
"""
import os
import json
import re
from typing import Optional
from sqlalchemy.orm import Session
from openai import OpenAI

from app.core.config import settings

# Initialize OpenAI client
openai_client = OpenAI(api_key=settings.openai_api_key) if settings.openai_api_key else None

# Domain profiles (simplified - can be loaded from DB)
DEFAULT_DOMAIN_PROFILE = {
    "domainLabel": "negocio",
    "assistantIdentity": "asistente comercial",
    "offeringLabel": "opciones",
    "offerCollectionLabel": "catálogo",
    "primaryObjective": "entender necesidad, resolver dudas y guiar al siguiente paso",
    "qualificationFields": ["necesidad", "presupuesto", "preferencias clave", "plazo"],
    "closingCta": "Si querés, avanzamos con el siguiente paso ahora.",
    "visitCta": "Si te sirve, coordinamos una demo.",
    "criteriaKeywords": ["busco", "quiero", "necesito", "presupuesto", "precio", "plan", "servicio", "opción", "cotización", "demo", "reunión"]
}

# Criteria keywords detection
CRITERIA_PATTERN = re.compile(
    r'\b(' + '|'.join(DEFAULT_DOMAIN_PROFILE["criteriaKeywords"]) + r')\b',
    re.IGNORECASE
)


def detect_criteria_keywords(text: str) -> list[str]:
    """Detect if text contains qualification criteria keywords"""
    matches = CRITERIA_PATTERN.findall(text.lower())
    return list(set(matches))


def classify_intent(text: str) -> str:
    """Simple intent classification"""
    text_lower = text.lower()
    
    # Greeting patterns
    if any(g in text_lower for g in ['hola', 'buenos', 'buenas', 'hi', 'hello', 'como estas']):
        return "greeting"
    
    # Criteria/qualification
    if detect_criteria_keywords(text):
        return "qualification"
    
    # Objection handling
    if any(o in text_lower for o in ['caro', 'muy caro', 'no quiero', 'no me sirve', 'otro', 'competencia']):
        return "objection"
    
    # Closing/closing attempt
    if any(c in text_lower for c in ['si', 'ok', 'dale', 'perfecto', 'me interesa', 'quiero']):
        return "closing"
    
    return "general"


def build_system_prompt(company_name: str = "negocio") -> str:
    """Build the system prompt for the AI agent"""
    return f"""Sos un {DEFAULT_DOMAIN_PROFILE['assistantIdentity']} de {company_name}.

Tu objetivo: {DEFAULT_DOMAIN_PROFILE['primaryObjective']}

Características:
- Sé amable, profesional y conversacional
- No seas demasiado formal
- Cuando detectes interés (presupuesto, necesidad, plazo), profundizá
- Usá CTAs naturales: "{DEFAULT_DOMAIN_PROFILE['closingCta']}"

Respondé de forma clara y concisa."""


async def generate_reply(
    text: str,
    conversation_history: list[dict] = None,
    company_name: str = "negocio"
) -> dict:
    """
    Generate an AI reply using OpenAI
    Migrated from Node.js generateConversationalReply
    """
    if not openai_client:
        return {
            "reply": "Lo siento, el servicio de IA no está configurado.",
            "model": "none",
            "usedFallback": True,
            "toolCallCount": 0,
            "knowledge": []
        }
    
    # Build messages
    messages = [
        {"role": "system", "content": build_system_prompt(company_name)}
    ]
    
    # Add conversation history (last 5 messages)
    if conversation_history:
        for msg in conversation_history[-5:]:
            messages.append({
                "role": "user" if not msg.get("fromMe", False) else "assistant",
                "content": msg.get("body", "")
            })
    
    # Add current message
    messages.append({"role": "user", "content": text})
    
    try:
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
        return {
            "reply": f"Disculpa, tuve un problema al procesar tu mensaje. ¿Podés repetirmelo?",
            "model": "error",
            "usedFallback": True,
            "toolCallCount": 0,
            "knowledge": [],
            "error": str(e)
        }


async def process_incoming_message(
    db: Session,
    contact_id: int,
    message_text: str,
    company_id: int
) -> dict:
    """
    Process an incoming WhatsApp message through the AI agent
    Returns the AI's reply if applicable
    """
    # Classify intent
    intent = classify_intent(message_text)
    
    # Get conversation history (last 10 messages)
    # This would query the messages table
    
    # Generate reply
    result = await generate_reply(
        text=message_text,
        conversation_history=[],  # TODO: load from DB
        company_name="Charlott"
    )
    
    return {
        "intent": intent,
        "reply": result["reply"],
        "model": result["model"],
        "usedFallback": result["usedFallback"]
    }
