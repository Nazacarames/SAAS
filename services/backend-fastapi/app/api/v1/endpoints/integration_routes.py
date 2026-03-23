"""
Integration Routes - External integrations (Tokko, etc.)
Migrated from Node.js integrationRoutes
"""
import os
import requests
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db
from app.core.config import settings

router = APIRouter(prefix="/integrations", tags=["integrations"])


# Optional auth dependency - returns None if no valid token
def optional_auth(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    try:
        from jose import jwt, JWTError
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except:
        return None


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


class PropertySearchInput(BaseModel):
    location: Optional[str] = ""
    price_min: Optional[int] = None
    price_max: Optional[int] = None
    property_type: Optional[str] = ""
    rooms: Optional[int] = None
    limit: int = 5


# --- Tokko Integration ---
def get_tokko_credentials(company_id: int = 1) -> Optional[dict]:
    """Get Tokko credentials from settings"""
    if settings.tokko_api_url and settings.tokko_api_key:
        return {
            "api_url": settings.tokko_api_url,
            "api_key": settings.tokko_api_key
        }
    return None


async def sync_lead_to_tokko(lead: LeadInput, company_id: int) -> dict:
    """Sync lead to Tokko API"""
    creds = get_tokko_credentials(company_id)
    
    if not creds:
        return {"ok": False, "reason": "tokko_not_configured"}
    
    try:
        api_url = creds["api_url"].rstrip("/")
        api_key = creds["api_key"]
        
        url = f"{api_url}/webcontact/?key={api_key}"
        
        payload = {
            "name": lead.name or "Lead Charlott",
            "phone": lead.phone.replace("+", "").replace(" ", ""),
            "email": lead.email,
            "text": lead.message or "Nuevo lead desde Charlott CRM",
            "source": lead.source or "Charlott CRM",
            "tags": ["Lead_Calificado", "Bot"] if not lead.tags else lead.tags
        }
        
        response = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=30)
        
        if response.status_code in [200, 201]:
            try:
                data = response.json() if response.text else {}
            except:
                data = {}
            return {"ok": True, "external_id": data.get("id") or data.get("lead_id")}
        else:
            return {"ok": False, "reason": "api_error", "status": response.status_code, "error": response.text[:200]}
    except Exception as e:
        return {"ok": False, "reason": "exception", "error": str(e)}


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
    
    row = db.execute(
        text('INSERT INTO contacts (name, number, email, "leadStatus", "companyId", "createdAt", "updatedAt") '
             'VALUES (:name, :phone, :email, :status, :company_id, NOW(), NOW()) RETURNING id'),
        {"name": lead.name, "phone": lead.phone.replace("+", ""), "email": lead.email, "status": "new", "company_id": company_id}
    ).mappings().first()
    db.commit()
    
    contact_id = row["id"]
    tokko_result = await sync_lead_to_tokko(lead, company_id)
    
    return {"ok": True, "contact_id": contact_id, "tokko": tokko_result}


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
    
    wa_config = db.execute(
        text('SELECT * FROM "whatsappConfigs" WHERE "companyId" = :company_id AND status = :status LIMIT 1'),
        {"company_id": company_id, "status": "CONNECTED"}
    ).mappings().first()
    
    if not wa_config:
        return {"ok": False, "reason": "whatsapp_not_connected"}
    
    phone_id = wa_config.get("phoneId")
    access_token = wa_config.get("token")
    
    if not phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}
    
    url = f"https://graph.facebook.com/v21.0/{phone_id}/messages"
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    
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
            return {"ok": True, "message_id": data.get("messages", [{}])[0].get("id")}
        else:
            return {"ok": False, "reason": "api_error", "error": response.text}
    except Exception as e:
        return {"ok": False, "reason": "exception", "error": str(e)}


@router.get("/messages/hardening-status")
async def get_hardening_status(payload: dict = Depends(get_current_user_payload)):
    """Get integration hardening metrics"""
    return {"ok": True, "metrics": {"outbound_total": 0, "outbound_success": 0, "outbound_failed": 0}}


@router.get("/tokko/status")
async def tokko_status(payload: dict = Depends(optional_auth)):
    """Get Tokko integration status"""
    company_id = (payload.get("companyId") if payload else 1) if payload else 1
    creds = get_tokko_credentials(company_id)
    return {"ok": True, "connected": creds is not None}


@router.post("/tokko/properties/search")
async def tokko_search_properties(
    search: PropertySearchInput,
    payload: dict = Depends(optional_auth)
):
    """Search properties in Tokko API"""
    import httpx
    
    company_id = (payload.get("companyId") if payload else 1) if payload else 1
    creds = get_tokko_credentials(company_id)
    
    if not creds:
        raise HTTPException(status_code=400, detail="Tokko not configured")
    
    params = {"key": creds["api_key"], "limit": search.limit, "operations": "sale"}
    
    if search.location:
        params["location"] = search.location
    if search.price_min:
        params["price_min"] = search.price_min
    if search.price_max:
        params["price_max"] = search.price_max
    if search.property_type:
        params["property_type"] = search.property_type
    if search.rooms:
        params["rooms_min"] = search.rooms
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{creds['api_url']}/properties", params=params, timeout=30.0)
            
            if resp.status_code == 200:
                data = resp.json()
                properties = []
                for prop in data.get("objects", [])[:search.limit]:
                    properties.append({
                        "id": prop.get("id"),
                        "title": prop.get("title", ""),
                        "location": prop.get("location", ""),
                        "address": prop.get("address", ""),
                        "price": prop.get("price", 0),
                        "currency": prop.get("currency", "USD"),
                        "type": prop.get("type", ""),
                        "rooms": prop.get("rooms", 0),
                        "bathrooms": prop.get("bathrooms", 0),
                        "total_area": prop.get("total_area", 0),
                        "description": prop.get("description", "")[:200],
                        "url": prop.get("url", "")
                    })
                return {"ok": True, "count": len(properties), "properties": properties}
            else:
                return {"ok": False, "error": f"Tokko API error: {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/tokko/properties/{property_id}/photos")
async def tokko_get_property_photos(
    property_id: int,
    payload: dict = Depends(optional_auth)
):
    """Get photos for a property from Tokko"""
    import httpx
    
    company_id = (payload.get("companyId") if payload else 1) if payload else 1
    creds = get_tokko_credentials(company_id)
    
    if not creds:
        raise HTTPException(status_code=400, detail="Tokko not configured")
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{creds['api_url']}/properties/{property_id}", params={"key": creds["api_key"]}, timeout=30.0)
            
            if resp.status_code == 200:
                data = resp.json()
                photos = []
                for i, photo in enumerate(data.get("images", [])[:5]):
                    photos.append({"index": i + 1, "url": photo.get("image", "")})
                return {"ok": True, "photos": photos}
            else:
                return {"ok": False, "error": f"Tokko API error: {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/")
async def list_integrations(payload: dict = Depends(optional_auth)):
    """List all integrations"""
    return {"tokko": {"connected": False}, "meta": {"connected": False}, "whatsapp": {"connected": True}}
