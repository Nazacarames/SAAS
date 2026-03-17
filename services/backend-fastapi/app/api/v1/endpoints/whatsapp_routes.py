from fastapi import APIRouter, Depends, HTTPException
from app.api.deps import get_current_user_payload

router = APIRouter(prefix="", tags=["whatsapp"])


@router.get("/api/whatsapps")
def list_whatsapps(payload: dict = Depends(get_current_user_payload)):
    return []


@router.get("/api/whatsapps/{whatsappId}")
def get_whatsapp(whatsappId: int, payload: dict = Depends(get_current_user_payload)):
    raise HTTPException(status_code=404, detail="Not found")


@router.post("/api/whatsapps")
def create_whatsapp(payload: dict = Depends(get_current_user_payload)):
    raise HTTPException(status_code=404, detail="Not found")


@router.delete("/api/whatsapps/{whatsappId}")
def delete_whatsapp(whatsappId: int, payload: dict = Depends(get_current_user_payload)):
    raise HTTPException(status_code=404, detail="Not found")
