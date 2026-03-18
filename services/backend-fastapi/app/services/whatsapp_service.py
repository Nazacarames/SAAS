"""
WhatsApp Cloud API Service - Send messages
"""
import os
import requests
from typing import Optional
from sqlalchemy.orm import Session

from app.core.config import settings


async def send_whatsapp_message(
    phone: str,
    text: str,
    whatsapp_phone_id: str = None,
    access_token: str = None
) -> dict:
    """
    Send a WhatsApp message via Cloud API
    """
    # Get from settings or environment
    if not whatsapp_phone_id:
        whatsapp_phone_id = os.getenv("WHATSAPP_PHONE_ID", "")
    if not access_token:
        access_token = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
    
    if not whatsapp_phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}
    
    url = f"https://graph.facebook.com/v21.0/{whatsapp_phone_id}/messages"
    
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
            return {
                "ok": False,
                "reason": "api_error",
                "status": response.status_code,
                "error": response.text
            }
    except Exception as e:
        return {
            "ok": False,
            "reason": "exception",
            "error": str(e)
        }


async def send_whatsapp_template(
    phone: str,
    template_name: str,
    components: list = None,
    whatsapp_phone_id: str = None,
    access_token: str = None
) -> dict:
    """Send a WhatsApp template message"""
    if not whatsapp_phone_id:
        whatsapp_phone_id = os.getenv("WHATSAPP_PHONE_ID", "")
    if not access_token:
        access_token = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
    
    if not whatsapp_phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}
    
    url = f"https://graph.facebook.com/v21.0/{whatsapp_phone_id}/messages"
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": "es_AR"},
            "components": components or []
        }
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
            return {
                "ok": False,
                "reason": "api_error",
                "status": response.status_code,
                "error": response.text
            }
    except Exception as e:
        return {
            "ok": False,
            "reason": "exception",
            "error": str(e)
        }
