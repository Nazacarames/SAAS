"""
Integration Routes - External integrations (Tokko, etc.)
Migrated from Node.js integrationRoutes
"""
import os
import requests
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db

router = APIRouter(prefix="/integrations", tags=["integrations"])


# --- Schemas ---
class LeadInput(BaseModel):
    name: str
    phone: str
    email: str = ""
    source: str = "web"
    message: str = ""
    tags: List[str] = []


class OutboundMessageInput(BaseModel):
    phone: str
    body: str
    contact_id: Optional[int] = None


# --- Tokko Integration ---
def get_tokko_credentials(company_id: int) -> Optional[dict]:
    """Get Tokko credentials from settings"""
    # TODO: load from company settings table
    return None


async def sync_lead_to_tokko(lead: LeadInput, company_id: int) -> dict:
    """Sync lead to Tokko API"""
    creds = get_tokko_credentials(company_id)
    
    if not creds:
        return {"ok": False, "reason": "tokko_not_configured"}
    
    # TODO: implement actual Tokko API call
    return {"ok": True, "external_id": None}


@router.post("/leads")
async def create_lead(
    lead: LeadInput,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Create lead via integration API"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # Save lead to database
    row = db.execute(
        text(
            'INSERT INTO contacts (name, number, email, "leadStatus", "companyId", "createdAt", "updatedAt") '
            'VALUES (:name, :phone, :email, :status, :company_id, NOW(), NOW()) '
            'RETURNING id'
        ),
        {"name": lead.name, "phone": lead.phone.replace("+", ""), "email": lead.email, "status": "new", "company_id": company_id}
    ).mappings().first()
    db.commit()
    
    contact_id = row["id"]
    
    # Try to sync to Tokko
    tokko_result = await sync_lead_to_tokko(lead, company_id)
    
    return {
        "ok": True,
        "contact_id": contact_id,
        "tokko": tokko_result
    }


@router.post("/messages")
async def send_outbound_message(
    msg: OutboundMessageInput,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Send outbound message via integration"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # Get WhatsApp configuration
    wa_config = db.execute(
        text('SELECT * FROM "whatsappConfigs" WHERE "companyId" = :company_id AND status = :status LIMIT 1'),
        {"company_id": company_id, "status": "CONNECTED"}
    ).mappings().first()
    
    if not wa_config:
        return {"ok": False, "reason": "whatsapp_not_connected"}
    
    # Send via WhatsApp Cloud API
    phone_id = wa_config.get("phoneId")
    access_token = wa_config.get("token")
    
    if not phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}
    
    url = f"https://graph.facebook.com/v21.0/{phone_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    payload_data = {
        "messaging_product": "whatsapp",
        "to": msg.phone,
        "type": "text",
        "text": {"body": msg.body}
    }
    
    try:
        response = requests.post(url, json=payload_data, headers=headers, timeout=30)
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
                "error": response.text
            }
    except Exception as e:
        return {
            "ok": False,
            "reason": "exception",
            "error": str(e)
        }


@router.get("/messages/hardening-status")
async def get_hardening_status(
    payload: dict = Depends(get_current_user_payload)
):
    """Get integration hardening metrics"""
    return {
        "ok": True,
        "metrics": {
            "outbound_total": 0,
            "outbound_success": 0,
            "outbound_failed": 0
        }
    }


@router.get("/tokko/status")
async def tokko_status(
    payload: dict = Depends(get_current_user_payload)
):
    """Get Tokko integration status"""
    company_id = payload.get("companyId")
    creds = get_tokko_credentials(company_id)
    
    return {
        "ok": True,
        "connected": creds is not None
    }


@router.get("/")
async def list_integrations(
    payload: dict = Depends(get_current_user_payload)
):
    """List all integrations"""
    return {
        "tokko": {"connected": False},
        "meta": {"connected": False},
        "whatsapp": {"connected": True}
    }
