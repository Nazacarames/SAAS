from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import text
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
    # Un asesor ve solo sus leads. No es un filtro que pueda sacar desde el
    # navegador: se impone acá, sobre lo que haya pedido el cliente.
    if str(payload.get("profile", "")).lower() not in {"admin", "super"}:
        assigned_user_id = int(payload.get("id") or 0) or -1

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
    """Manual send from the inbox. Free text ({body}) routed by channel
    (WhatsApp / Instagram / Messenger según el contacto) y templates de
    WhatsApp ({templateName, languageCode}) fuera de la ventana de 24h."""
    from sqlalchemy import text as _t
    company_id = payload.get("companyId")
    contact = db.execute(
        _t('SELECT id, name, number, igsid, psid FROM contacts WHERE id = :id AND "companyId" = :cid LIMIT 1'),
        {"id": contact_id, "cid": company_id},
    ).mappings().first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contacto no encontrado")

    from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, send_whatsapp_message, save_message

    template_name = str(body.get("templateName") or "").strip()
    if template_name:
        if not contact["number"]:
            raise HTTPException(status_code=400, detail="Los templates son solo para contactos de WhatsApp")
        wa = get_whatsapp_config(db, company_id)
        if not wa:
            raise HTTPException(status_code=400, detail="No hay canal de WhatsApp configurado")
        import httpx as _hx
        lang = str(body.get("languageCode") or "es_AR")
        resp = _hx.post(
            f"https://graph.facebook.com/v21.0/{wa['phoneId']}/messages",
            json={"messaging_product": "whatsapp", "to": str(contact["number"]),
                  "type": "template", "template": {"name": template_name, "language": {"code": lang}}},
            headers={"Authorization": f"Bearer {wa['token']}"}, timeout=20,
        )
        if resp.status_code != 200:
            err = resp.json().get("error", {}).get("message", "")[:200]
            raise HTTPException(status_code=502, detail=f"Meta rechazó el template: {err}")
        saved_body = f"[template {template_name}]"
    else:
        text_body = str(body.get("body") or "").strip()
        if not text_body:
            raise HTTPException(status_code=400, detail="body o templateName requerido")

        # Ruteo por canal: el contacto define por dónde se le responde
        if contact["igsid"] or contact["psid"]:
            from app.services.channels.registry import get_adapter, get_primary_channel, get_send_config
            ctype = "instagram" if contact["igsid"] else "messenger"
            channel = get_primary_channel(db, company_id, ctype)
            if not channel:
                raise HTTPException(status_code=400, detail=f"No hay canal de {ctype} activo")
            adapter = get_adapter(ctype)
            res = await adapter.send_text(get_send_config(channel), contact["igsid"] or contact["psid"], text_body)
            if not res.ok:
                raise HTTPException(status_code=502, detail=str(res.error or "Meta rechazó el mensaje")[:250])
        elif contact["number"]:
            wa = get_whatsapp_config(db, company_id)
            if not wa:
                raise HTTPException(status_code=400, detail="No hay canal de WhatsApp configurado")
            result = await send_whatsapp_message(str(contact["number"]), text_body, wa)
            if not result.get("ok"):
                raise HTTPException(status_code=502, detail=str(result.get("error", "Meta rechazó el mensaje"))[:250])
        else:
            raise HTTPException(status_code=400, detail="El contacto no tiene canal de contacto")
        saved_body = text_body

    try:
        save_message(db, int(contact["id"]), saved_body, True, int(company_id))
        from app.services.billing_service import increment_usage
        increment_usage(db, company_id, "messages_sent")
    except Exception:
        pass
    return {"ok": True}


# ── Lista de exclusión del agente ─────────────────────────────────────
# Clientes históricos que el negocio no quiere que atienda la IA. No alcanza
# con pausar los contactos existentes: el histórico que escribe por primera vez
# al CRM entra como contacto nuevo. Por eso la lista vive aparte y se aplica al
# crear el contacto (contacts_service._is_ai_optout).

class AiOptoutBody(BaseModel):
    numbers: list[str]
    note: str = ""


@router.post("/ai-optouts")
def ai_optouts_add(
    body: AiOptoutBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    digits = {"".join(c for c in str(n) if c.isdigit()) for n in body.numbers}
    digits = {d for d in digits if len(d) >= 8}
    if not digits:
        raise HTTPException(status_code=400, detail="No hay números válidos en la lista")

    for d in digits:
        db.execute(
            text("""INSERT INTO ai_optouts (company_id, number, note)
                    VALUES (:c, :n, :note) ON CONFLICT (company_id, number) DO NOTHING"""),
            {"c": company_id, "n": d, "note": body.note[:200]},
        )
    # los que ya están en el CRM se pausan de una
    # por sufijo: contacts.number viene con formato ("+54 9 3465 40-7454") y con
    # o sin el 9, asi que la comparacion exacta no pausaba a nadie
    paused = db.execute(
        text('UPDATE contacts SET ai_paused = true, "updatedAt" = NOW() '
             'WHERE "companyId" = :c AND COALESCE(ai_paused, false) = false '
             "AND right(regexp_replace(COALESCE(number,''), '[^0-9]', '', 'g'), 8) = ANY(:sufs)"),
        {"c": company_id, "sufs": [d[-8:] for d in digits]},
    ).rowcount
    db.commit()
    total = db.execute(text("SELECT COUNT(*) FROM ai_optouts WHERE company_id = :c"), {"c": company_id}).scalar()
    return {"ok": True, "cargados": len(digits), "contactos_pausados": paused, "total_en_lista": total}


@router.get("/ai-optouts")
def ai_optouts_list(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    rows = db.execute(
        text("SELECT number, note, created_at FROM ai_optouts WHERE company_id = :c ORDER BY id DESC LIMIT 2000"),
        {"c": company_id},
    ).mappings().all()
    return {"ok": True, "total": len(rows), "numeros": [dict(r) for r in rows]}


@router.delete("/ai-optouts/{number}")
def ai_optouts_remove(
    number: str,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    d = "".join(c for c in number if c.isdigit())
    db.execute(text("DELETE FROM ai_optouts WHERE company_id = :c AND number = :n"), {"c": company_id, "n": d})
    db.commit()
    return {"ok": True}
