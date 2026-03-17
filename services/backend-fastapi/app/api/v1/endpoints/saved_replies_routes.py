from fastapi import APIRouter, Depends
from app.api.deps import get_current_user_payload

router = APIRouter(prefix="", tags=["saved-replies"])


@router.get("/api/saved-replies")
def list_saved_replies(payload: dict = Depends(get_current_user_payload)):
    return []


@router.post("/api/saved-replies")
def create_saved_reply(payload: dict = Depends(get_current_user_payload)):
    return {"id": 1}
