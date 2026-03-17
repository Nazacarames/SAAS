from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db
from app.schemas.contacts import ContactCreateRequest, ContactOut, ContactUpdateRequest
from app.services.contacts_service import (
    create_contact,
    delete_contact,
    list_contacts,
    mark_contact_read,
    update_contact,
)

router = APIRouter(prefix="/contacts", tags=["contacts"])


@router.get("/", response_model=list[ContactOut])
def contacts_list(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    status_filter: str | None = Query(default=None, alias="status"),
    assigned_user_id_raw: str | None = Query(default=None, alias="assignedUserId"),
    limit: int = Query(default=200, ge=1, le=500),
):
    company_id = int(payload.get("companyId") or 0)
    assigned_user_id = None
    if assigned_user_id_raw is not None and assigned_user_id_raw != "null":
        assigned_user_id = int(assigned_user_id_raw)

    return list_contacts(
        db,
        company_id=company_id,
        status=status_filter,
        assigned_user_id=assigned_user_id,
        limit=limit,
    )


@router.post("/", response_model=ContactOut, status_code=status.HTTP_201_CREATED)
def contacts_create(
    body: ContactCreateRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    return create_contact(db, company_id=company_id, payload=body.model_dump())


@router.put("/{contact_id}", response_model=ContactOut)
def contacts_update(
    contact_id: int,
    body: ContactUpdateRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    updated = update_contact(
        db,
        company_id=company_id,
        contact_id=contact_id,
        payload=body.model_dump(exclude_unset=True),
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Contacto no encontrado")
    return updated


@router.delete("/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def contacts_delete(
    contact_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    deleted = delete_contact(db, company_id=company_id, contact_id=contact_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Contacto no encontrado")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{contact_id}/mark-read", response_model=ContactOut)
def contacts_mark_read(
    contact_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    result = mark_contact_read(db, company_id=company_id, contact_id=contact_id)
    if not result:
        raise HTTPException(status_code=404, detail="Contacto no encontrado")
    return result
