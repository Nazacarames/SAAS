"""
Integration Routes - External integrations
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import get_current_user_payload

router = APIRouter(tags=["integrations"])


class TokkoLeadInput(BaseModel):
    name: str
    phone: str
    email: str = ""
    source: str = "web"
    message: str = ""
    tags: list = []


@router.post("/integrations/tokko/sync-lead")
async def tokko_sync_lead(
    lead: TokkoLeadInput,
    payload: dict = Depends(get_current_user_payload)
):
    """Sync lead to Tokko"""
    # TODO: implement actual Tokko integration
    return {"ok": True, "reason": "not_implemented"}


@router.get("/integrations/tokko/status")
async def tokko_status(payload: dict = Depends(get_current_user_payload)):
    """Get Tokko integration status"""
    return {"ok": True, "connected": False}


@router.get("/integrations/")
async def list_integrations(payload: dict = Depends(get_current_user_payload)):
    """List all integrations"""
    return {
        "tokko": {"connected": False},
        "meta": {"connected": False},
        "whatsapp": {"connected": True}
    }
