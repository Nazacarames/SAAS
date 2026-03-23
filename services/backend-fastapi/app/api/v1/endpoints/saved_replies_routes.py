from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db

router = APIRouter(prefix="", tags=["saved-replies"])


class SavedReplyOut(BaseModel):
    id: int
    shortcut: str
    message: str
    companyId: int

    class Config:
        from_attributes = True


class SavedReplyCreate(BaseModel):
    shortcut: str
    message: str


class SavedReplyUpdate(BaseModel):
    shortcut: str | None = None
    message: str | None = None


# ── GET /api/saved-replies ──────────────────────────────────────
@router.get("/api/saved-replies", response_model=list[SavedReplyOut])
def list_saved_replies(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    rows = db.execute(
        text(
            'SELECT id, shortcut, message, "companyId" '
            "FROM saved_replies WHERE \"companyId\" = :company_id "
            'ORDER BY "updatedAt" DESC'
        ),
        {"company_id": company_id},
    ).mappings().all()
    return [dict(row) for row in rows]


# ── POST /api/saved-replies ──────────────────────────────────────
@router.post("/api/saved-replies", response_model=SavedReplyOut, status_code=201)
def create_saved_reply(
    body: SavedReplyCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    shortcut = body.shortcut.strip()
    message = body.message.strip()

    if not shortcut or not message:
        raise HTTPException(status_code=400, detail="shortcut y message son obligatorios")

    row = db.execute(
        text(
            'INSERT INTO saved_replies (shortcut, message, "companyId", "createdAt", "updatedAt") '
            'VALUES (:shortcut, :message, :company_id, NOW(), NOW()) RETURNING id, shortcut, message, "companyId"'
        ),
        {"shortcut": shortcut, "message": message, "company_id": company_id},
    ).mappings().first()

    db.commit()
    return dict(row)


# ── PUT /api/saved-replies/{id} ──────────────────────────────────
@router.put("/api/saved-replies/{reply_id}", response_model=SavedReplyOut)
def update_saved_reply(
    reply_id: int,
    body: SavedReplyUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    # Check exists and belongs to company
    existing = db.execute(
        text(
            'SELECT id, shortcut, message FROM saved_replies '
            'WHERE id = :id AND "companyId" = :company_id LIMIT 1'
        ),
        {"id": reply_id, "company_id": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="Plantilla no encontrada")

    shortcut = body.shortcut.strip() if body.shortcut is not None else existing["shortcut"]
    message = body.message.strip() if body.message is not None else existing["message"]

    row = db.execute(
        text(
            'UPDATE saved_replies SET shortcut = :shortcut, message = :message, "updatedAt" = NOW() '
            'WHERE id = :id RETURNING id, shortcut, message, "companyId"'
        ),
        {"shortcut": shortcut, "message": message, "id": reply_id},
    ).mappings().first()

    db.commit()
    return dict(row)


# ── DELETE /api/saved-replies/{id} ──────────────────────────────────
@router.delete("/api/saved-replies/{reply_id}", status_code=204)
def delete_saved_reply(
    reply_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    # Check exists and belongs to company
    existing = db.execute(
        text(
            'SELECT id FROM saved_replies '
            'WHERE id = :id AND "companyId" = :company_id LIMIT 1'
        ),
        {"id": reply_id, "company_id": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="Plantilla no encontrada")

    db.execute(
        text('DELETE FROM saved_replies WHERE id = :id'),
        {"id": reply_id},
    )
    db.commit()
    return None
