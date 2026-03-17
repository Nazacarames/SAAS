from fastapi import APIRouter, Depends
from app.api.deps import get_current_user_payload

router = APIRouter(prefix="", tags=["settings"])


@router.get("/api/settings/whatsapp-cloud")
def get_settings_whatsapp_cloud(payload: dict = Depends(get_current_user_payload)):
    return {"settings": {}}


@router.put("/api/settings/whatsapp-cloud")
def update_settings_whatsapp_cloud(payload: dict = Depends(get_current_user_payload)):
    return {"ok": True}
