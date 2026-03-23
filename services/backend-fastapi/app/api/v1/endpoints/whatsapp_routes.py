from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db

router = APIRouter(prefix="/whatsapps", tags=["whatsapp"])


class WhatsAppOut(BaseModel):
    id: int
    name: str
    status: str
    battery: str | None = None
    plugged: bool | None = None
    isDefault: bool
    greetingMessage: str | None = None
    farewellMessage: str | None = None
    createdAt: str | None = None
    updatedAt: str | None = None

    class Config:
        from_attributes = True


class CreateWhatsAppRequest(BaseModel):
    name: str
    isDefault: bool = False


# ── GET /api/whatsapps ───────────────────────────────────────────
@router.get("/", response_model=list[WhatsAppOut])
def list_whatsapps(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    rows = db.execute(
        text(
            """SELECT id, name, status, battery, plugged, "isDefault",
                      "greetingMessage", "farewellMessage",
                      "createdAt"::text, "updatedAt"::text
               FROM whatsapps WHERE "companyId" = :company_id
               ORDER BY "name" ASC"""
        ),
        {"company_id": company_id},
    ).mappings().all()

    # Note: ListWhatsappsService in Node.js also checks runtime settings
    # for cloudConfigured and cloudId to normalize status. For now, return raw data.
    return [dict(row) for row in rows]


# ── POST /api/whatsapps ───────────────────────────────────────────
@router.post("/", response_model=WhatsAppOut, status_code=201)
def create_whatsapp(
    body: CreateWhatsAppRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    name = body.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="name es requerido")

    row = db.execute(
        text(
            """INSERT INTO whatsapps (name, "companyId", status, "isDefault", "createdAt", "updatedAt")
               VALUES (:name, :company_id, 'DISCONNECTED', :is_default, NOW(), NOW())
               RETURNING id, name, status, battery, plugged, "isDefault",
                         "greetingMessage", "farewellMessage",
                         "createdAt"::text, "updatedAt"::text"""
        ),
        {"name": name, "company_id": company_id, "is_default": body.isDefault},
    ).mappings().first()

    db.commit()
    return dict(row)


# ── GET /api/whatsapps/{whatsapp_id} ────────────────────────────
@router.get("/{whatsapp_id}", response_model=WhatsAppOut)
def get_whatsapp(
    whatsapp_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    row = db.execute(
        text(
            """SELECT id, name, status, battery, plugged, "isDefault",
                      "greetingMessage", "farewellMessage",
                      "createdAt"::text, "updatedAt"::text
               FROM whatsapps
               WHERE id = :whatsapp_id AND "companyId" = :company_id
               LIMIT 1"""
        ),
        {"whatsapp_id": whatsapp_id, "company_id": company_id},
    ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="WhatsApp connection not found")

    return dict(row)


# ── DELETE /api/whatsapps/{whatsapp_id} ──────────────────────────
@router.delete("/{whatsapp_id}", status_code=204)
def delete_whatsapp(
    whatsapp_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    # Check exists and belongs to company
    existing = db.execute(
        text(
            """SELECT id FROM whatsapps
               WHERE id = :whatsapp_id AND "companyId" = :company_id
               LIMIT 1"""
        ),
        {"whatsapp_id": whatsapp_id, "company_id": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="WhatsApp connection not found")

    # Delete in transaction: set whatsappId null in users, contacts, then delete messages/tickets
    # Finally delete the whatsapp itself

    # Get ticket IDs first
    ticket_rows = db.execute(
        text(
            """SELECT id FROM tickets
               WHERE "whatsappId" = :whatsapp_id AND "companyId" = :company_id"""
        ),
        {"whatsapp_id": whatsapp_id, "company_id": company_id},
    ).mappings().all()
    ticket_ids = [r["id"] for r in ticket_rows]

    # Set whatsappId null in users
    db.execute(
        text(
            """UPDATE users SET "whatsappId" = NULL
               WHERE "whatsappId" = :whatsapp_id AND "companyId" = :company_id"""
        ),
        {"whatsapp_id": whatsapp_id, "company_id": company_id},
    )

    # Set whatsappId null in contacts
    db.execute(
        text(
            """UPDATE contacts SET "whatsappId" = NULL
               WHERE "whatsappId" = :whatsapp_id AND "companyId" = :company_id"""
        ),
        {"whatsapp_id": whatsapp_id, "company_id": company_id},
    )

    # Delete messages if there are tickets
    if ticket_ids:
        db.execute(
            text('DELETE FROM messages WHERE "ticketId" = ANY(:ticket_ids)'),
            {"ticket_ids": ticket_ids},
        )

        db.execute(
            text('DELETE FROM tickets WHERE id = ANY(:ticket_ids)'),
            {"ticket_ids": ticket_ids},
        )

    # Delete whatsapp
    db.execute(
        text('DELETE FROM whatsapps WHERE id = :whatsapp_id'),
        {"whatsapp_id": whatsapp_id},
    )

    db.commit()
    return None
