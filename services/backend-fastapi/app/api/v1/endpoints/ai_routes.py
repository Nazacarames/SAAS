from fastapi import APIRouter, Depends, HTTPException
from app.api.deps import get_current_user_payload

router = APIRouter(prefix="", tags=["ai"])


@router.get("/api/ai/funnel/stats")
def ai_funnel_stats(payload: dict = Depends(get_current_user_payload)):
    return {"data": []}


@router.post("/api/ai/meta-leads/webhook")
def ai_meta_leads_webhook():
    return {"ok": True}


@router.get("/api/ai/appointments")
def ai_appointments(payload: dict = Depends(get_current_user_payload)):
    return []


@router.get("/api/ai/reports/attribution")
def ai_reports_attribution(payload: dict = Depends(get_current_user_payload)):
    return []


@router.get("/api/ai/kb/stats")
def ai_kb_stats(payload: dict = Depends(get_current_user_payload)):
    return {}


@router.get("/api/ai/kb/documents")
def ai_kb_documents(payload: dict = Depends(get_current_user_payload)):
    return []


@router.get("/api/ai/templates")
def ai_templates(payload: dict = Depends(get_current_user_payload)):
    return []
