from fastapi import APIRouter, Request, HTTPException, Response, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
import hashlib
import hmac
import time
import json

from app.core.db import get_db
from app.services.ai_agent_service import process_incoming_message, generate_reply
from app.services.contacts_service import get_contact_by_phone
from app.services.messages_service import create_message, get_conversation_messages

router = APIRouter(prefix="/whatsapp-cloud", tags=["whatsapp-webhook"])

# In-memory replay cache (simple version)
replay_cache: dict[str, float] = {}
SIGNATURE_MAX_AGE_SECONDS = 300


def get_app_secret() -> str:
    # TODO: load from settings/DB
    return ""


def verify_signature(req: Request, body: bytes, signature: str | None) -> bool:
    app_secret = get_app_secret()
    if not app_secret or not signature:
        return True  # Skip in dev

    expected = hmac.new(
        app_secret.encode(),
        body,
        "sha256"
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def check_replay(body: bytes) -> bool:
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time()

    # Clean old entries
    global replay_cache
    replay_cache = {k: v for k, v in replay_cache.items() if now - v < 3600}

    if key in replay_cache:
        return False

    replay_cache[key] = now
    return True


class WebhookResponse(BaseModel):
    ok: bool = True
    ignored: bool = False
    reason: str = ""
    ai_reply: str = None


def extract_message_from_payload(payload: dict) -> tuple[str, str, str]:
    """
    Extract message info from WhatsApp Cloud webhook payload
    Returns: (message_id, from_number, message_text)
    """
    try:
        entries = payload.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})
                messages = value.get("messages", [])
                for msg in messages:
                    msg_id = msg.get("id", "")
                    from_num = msg.get("from", "")
                    
                    # Handle text messages
                    if msg.get("type") == "text":
                        text = msg.get("text", {}).get("body", "")
                        return msg_id, from_num, text
                    
                    # Handle other types (simplified)
                    return msg_id, from_num, f"[{msg.get('type', 'unknown')} message]"
        
        return "", "", ""
    except Exception as e:
        return "", "", ""


@router.post("/webhook", response_model=WebhookResponse)
async def whatsapp_webhook(req: Request, response: Response, db: Session = Depends(get_db)):
    body = await req.body()

    # Signature verification (optional in dev)
    signature = req.headers.get("x-hub-signature-256", "")
    if not verify_signature(req, body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Replay protection
    if not check_replay(body):
        response.status_code = 202
        return {"ok": True, "ignored": True, "reason": "replay_blocked", "ai_reply": None}

    # Parse payload
    try:
        payload = json.loads(body)
    except:
        return {"ok": True, "ignored": True, "reason": "invalid_json", "ai_reply": None}

    # Extract message
    msg_id, from_number, message_text = extract_message_from_payload(payload)
    
    if not message_text:
        return {"ok": True, "ignored": True, "reason": "no_text_message", "ai_reply": None}

    # Find or create contact
    contact = get_contact_by_phone(db, from_number)
    if not contact:
        return {"ok": True, "ignored": True, "reason": "unknown_contact", "ai_reply": None}

    # Get conversation messages for context
    conversation_history = get_conversation_messages(db, contact.id)
    
    # Process through AI agent
    try:
        ai_result = await generate_reply(
            text=message_text,
            conversation_history=conversation_history,
            company_name="Charlott"
        )
        
        ai_reply = ai_result.get("reply", "")
        
        # TODO: Save incoming message to DB
        # TODO: Save AI reply to DB and send via WhatsApp API
        
        return {
            "ok": True,
            "ignored": False,
            "reason": "",
            "ai_reply": ai_reply
        }
        
    except Exception as e:
        return {
            "ok": True,
            "ignored": False,
            "reason": f"error: {str(e)}",
            "ai_reply": None
        }
