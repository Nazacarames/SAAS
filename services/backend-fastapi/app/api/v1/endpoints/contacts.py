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

@router.post("/{contact_id}/message")
async def contacts_send_message(
    contact_id: int,
    body: dict,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Manual send from the inbox. Supports free-form text ({body}) inside the
    24h window and WhatsApp templates ({templateName, languageCode}) outside it."""
    from sqlalchemy import text as _t
    company_id = payload.get("companyId")
    contact = db.execute(
        _t('SELECT id, name, number FROM contacts WHERE id = :id AND "companyId" = :cid LIMIT 1'),
        {"id": contact_id, "cid": company_id},
    ).mappings().first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contacto no encontrado")
    if not contact["number"]:
        raise HTTPException(status_code=400, detail="El contacto no tiene número")

    from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, send_whatsapp_message, save_message
    wa = get_whatsapp_config(db, company_id)
    if not wa:
        raise HTTPException(status_code=400, detail="No hay canal de WhatsApp configurado")

    template_name = str(body.get("templateName") or "").strip()
    if template_name:
        import httpx as _hx
        lang = str(body.get("languageCode") or "es_AR")
        resp = _hx.post(
            f"https://graph.facebook.com/v21.0/{wa['phone_number_id']}/messages",
            json={"messaging_product": "whatsapp", "to": str(contact["number"]),
                  "type": "template", "template": {"name": template_name, "language": {"code": lang}}},
            headers={"Authorization": f"Bearer {wa['access_token']}"}, timeout=20,
        )
        if resp.status_code != 200:
            err = resp.json().get("error", {}).get("message", "")[:200]
            raise HTTPException(status_code=502, detail=f"Meta rechazó el template: {err}")
        saved_body = f"[template {template_name}]"
    else:
        text_body = str(body.get("body") or "").strip()
        if not text_body:
            raise HTTPException(status_code=400, detail="body o templateName requerido")
        result = await send_whatsapp_message(str(contact["number"]), text_body, wa)
        if not result.get("ok"):
            raise HTTPException(status_code=502, detail=str(result.get("error", "Meta rechazó el mensaje"))[:250])
        saved_body = text_body

    try:
        save_message(db, int(contact["id"]), saved_body, True, int(company_id))
        from app.services.billing_service import increment_usage
        increment_usage(db, company_id, "messages_sent")
    except Exception:
        pass
    return {"ok": True}
