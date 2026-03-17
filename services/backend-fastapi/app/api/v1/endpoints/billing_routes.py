from fastapi import APIRouter, Depends
from app.api.deps import get_current_user_payload

router = APIRouter(prefix="", tags=["billing"])


@router.get("/api/billing/status")
def billing_status(payload: dict = Depends(get_current_user_payload)):
    return {"status": "active"}
