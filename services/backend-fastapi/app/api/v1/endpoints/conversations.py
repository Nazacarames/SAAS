from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db
from app.schemas.conversations import ConversationUpdateRequest, ConversationUpdateResponse
from app.services.conversations_service import (
    list_conversations,
    list_conversations_paginated,
    update_conversation,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("/")
def conversations_list(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    status: str | None = Query(default=None),
    contactId: int | None = Query(default=None),
    page: int | None = Query(default=None, ge=1),
    limit: int | None = Query(default=None, ge=1, le=500),
):
    company_id = int(payload.get("companyId") or 0)

    # If page or limit provided → paginated mode
    if page is not None or limit is not None:
        return list_conversations_paginated(
            db,
            company_id=company_id,
            status=status,
            contact_id=contactId,
            page=page or 1,
            limit=limit or 50,
        )

    # Legacy mode — plain array
    return list_conversations(
        db,
        company_id=company_id,
        status=status,
        contact_id=contactId,
        limit=200,
    )


@router.put("/{conversation_id}", response_model=ConversationUpdateResponse)
def conversations_update(
    conversation_id: int,
    body: ConversationUpdateRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    updated = update_conversation(
        db,
        company_id=company_id,
        conversation_id=conversation_id,
        status=body.status,
        user_id=body.userId,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="conversación no encontrada")
    return updated
