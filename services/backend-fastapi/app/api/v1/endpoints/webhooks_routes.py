"""
Webhooks API - FastAPI implementation
Migrated from Node.js webhookRoutes
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db
from app.schemas.webhooks import WebhookCreate, WebhookOut, WebhookUpdate
from app.services import webhooks_service

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.get("/", response_model=List[WebhookOut])
def list_webhooks(
    payload: dict = Depends(get_current_user_payload),
    db = Depends(get_db)
):
    """List all webhooks for company"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    return webhooks_service.list_webhooks(db, company_id=company_id)


@router.post("/", response_model=WebhookOut)
def create_webhook(
    webhook: WebhookCreate,
    payload: dict = Depends(require_admin),
    db = Depends(get_db)
):
    """Create a new webhook"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    return webhooks_service.create_webhook(
        db,
        company_id=company_id,
        name=webhook.name,
        url=webhook.url,
        event=webhook.event,
        active=webhook.active,
        description=webhook.description
    )


@router.put("/{webhook_id}", response_model=WebhookOut)
def update_webhook(
    webhook_id: int,
    webhook: WebhookUpdate,
    payload: dict = Depends(require_admin),
    db = Depends(get_db)
):
    """Update a webhook"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    result = webhooks_service.update_webhook(
        db,
        company_id=company_id,
        webhook_id=webhook_id,
        name=webhook.name,
        url=webhook.url,
        event=webhook.event,
        active=webhook.active,
        description=webhook.description
    )
    if not result:
        raise HTTPException(status_code=404, detail="Webhook not found")
    
    return result


@router.delete("/{webhook_id}")
def delete_webhook(
    webhook_id: int,
    payload: dict = Depends(require_admin),
    db = Depends(get_db)
):
    """Delete a webhook"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    deleted = webhooks_service.delete_webhook(db, company_id=company_id, webhook_id=webhook_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Webhook not found")
    
    return {"ok": True}
