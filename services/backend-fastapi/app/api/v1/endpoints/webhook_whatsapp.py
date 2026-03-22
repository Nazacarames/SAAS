"""
WhatsApp Cloud Webhook - Handle incoming messages and process with AI Agent
Migrated from Node.js ProcessCloudWebhookService
"""
import os
import requests
from typing import Optional
from fastapi import APIRouter, Request, HTTPException, Response, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session
import hashlib
import hmac
import time
import json

from app.core.db import get_db
from app.core.config import settings
from app.services.ai_agent_service import generate_reply
from app.services.contacts_service import get_contact_by_phone
from app.services.messages_service import get_conversation_messages

router = APIRouter(prefix="/whatsapp-cloud", tags=["whatsapp-webhook"])

# In-memory replay cache
replay_cache: dict[str, float] = {}


def get_app_secret() -> str:
    """Get WhatsApp app secret from settings"""
    return os.getenv("WHATSAPP_APP_SECRET", "")


def verify_signature(req: Request, body: bytes, signature: str | None) -> bool:
    """Verify webhook signature"""
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
    """Check for replay attacks"""
    key = hashlib.sha256(body).hexdigest()[:64]
    now = time.time()

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
    ai_reply: Optional[str] = None


def extract_message_from_payload(payload: dict) -> tuple[str, str, str]:
    """Extract message info from WhatsApp Cloud webhook payload"""
    try:
        entries = payload.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})
                
                # First check for status updates (delivery receipts, etc.) - ignore these
                statuses = value.get("statuses", [])
                if statuses:
                    return "", "", ""
                
                # Then check for messages
                messages = value.get("messages", [])
                for msg in messages:
                    msg_id = msg.get("id", "")
                    from_num = msg.get("from", "")
                    
                    # Always try to get text.body first (works for text and some other types)
                    text_body = msg.get("text", {}).get("body", "")
                    if text_body:
                        return msg_id, from_num, text_body
                    
                    # If no text.body, check type
                    msg_type = msg.get("type", "unknown")
                    if msg_type == "text":
                        # This shouldn't be reached since text_body would be set above
                        return msg_id, from_num, text_body
                    
                    # Handle other types (image, document, etc.)
                    return msg_id, from_num, f"[{msg_type} message]"
        
        return "", "", ""
    except Exception as e:
        print(f"extract_message_from_payload error: {e}")
        return "", "", ""


def get_whatsapp_config(db: Session, company_id: int) -> Optional[dict]:
    """Get active WhatsApp configuration for company from company_runtime_settings"""
    row = db.execute(
        text('SELECT settings_json FROM company_runtime_settings WHERE company_id = :company_id LIMIT 1'),
        {"company_id": company_id}
    ).mappings().first()
    
    if not row:
        return None
    
    import json
    settings = json.loads(row["settings_json"])
    
    # Extract WhatsApp Cloud API credentials
    phone_id = settings.get("waCloudPhoneNumberId")
    access_token = settings.get("waCloudAccessToken")
    
    if not phone_id or not access_token:
        return None
    
    return {
        "phoneId": phone_id,
        "token": access_token
    }


def send_whatsapp_message(phone: str, text: str, config: dict) -> dict:
    """Send WhatsApp message via Cloud API"""
    phone_id = config.get("phoneId")
    access_token = config.get("token")
    
    if not phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}
    
    # Add country code if not present (54 for Argentina)
    phone = phone.strip().replace("+", "")
    if not phone.startswith("54"):
        phone = "54" + phone
    
    url = f"https://graph.facebook.com/v21.0/{phone_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "text",
        "text": {"body": text}
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        if response.status_code in [200, 201]:
            data = response.json()
            return {
                "ok": True,
                "message_id": data.get("messages", [{}])[0].get("id")
            }
        else:
            return {"ok": False, "reason": "api_error", "error": response.text[:200]}
    except Exception as e:
        return {"ok": False, "reason": "exception", "error": str(e)}


def save_message(db: Session, contact_id: int, body: str, from_me: bool, company_id: int) -> dict:
    """Save message to database"""
    row = db.execute(
        text(
            'INSERT INTO messages (body, "fromMe", "contactId", "createdAt", "updatedAt") '
            'VALUES (:body, :from_me, :contact_id, NOW(), NOW()) '
            'RETURNING id, body, "fromMe", "contactId"'
        ),
        {"body": body, "from_me": from_me, "contact_id": contact_id}
    ).mappings().first()
    db.commit()
    return dict(row)


@router.post("/webhook", response_model=WebhookResponse)
async def whatsapp_webhook(req: Request, response: Response, db: Session = Depends(get_db)):
    """Handle incoming WhatsApp messages"""
    body = await req.body()

    # Signature verification
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

    # Find contact
    contact = get_contact_by_phone(db, from_number)
    if not contact:
        return {"ok": True, "ignored": True, "reason": "unknown_contact", "ai_reply": None}

    company_id = contact.get("companyId", 1)
    
    # Save incoming message
    try:
        save_message(db, contact["id"], message_text, False, company_id)
    except Exception as e:
        print(f"Error saving incoming message: {e}")
        db.rollback()

    # Get conversation history for context - only USER messages, not AI messages
    try:
        db.rollback()  # Clear any aborted transaction state
        all_messages = get_conversation_messages(db, contact["id"])
    except Exception as e:
        print(f"Error getting conversation history: {e}")
        db.rollback()
        all_messages = []
    # Filter: only user messages (fromMe=False), exclude "[unknown message]" and empty
    conversation_history = [
        m for m in all_messages
        if not m.get("fromMe", True)  # User messages have fromMe=False
        and m.get("body")
        and not m["body"].startswith("[")  # Exclude "[xxx message]" types
    ]
    # Reverse to chronological order (oldest first)
    conversation_history = list(reversed(conversation_history))
    
    # Process through AI agent
    try:
        ai_result = await generate_reply(
            text=message_text,
            conversation_history=conversation_history,
            company_name="Charlott"
        )
        
        ai_reply = ai_result.get("reply", "")
        
        if ai_reply:
            # Save AI reply
            try:
                save_message(db, contact["id"], ai_reply, True, company_id)
            except Exception as e:
                print(f"Error saving AI reply: {e}")
            
            # Get WhatsApp config and send reply
            wa_config = get_whatsapp_config(db, company_id)
            if wa_config:
                send_result = send_whatsapp_message(from_number, ai_reply, wa_config)
                print(f"WhatsApp send result: {send_result}")
        
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


@router.get("/webhook")
async def whatsapp_webhook_verify(req: Request):
    """Verify webhook for WhatsApp Cloud API"""
    mode = req.query_params.get("hub.mode")
    token = req.query_params.get("hub.verify_token")
    challenge = req.query_params.get("hub.challenge")
    
    # Verify token (should match WhatsApp webhook verify token)
    verify_token = os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "atendechat")
    if token != verify_token:
        raise HTTPException(status_code=403, detail="Invalid verify token")
    
    return challenge
