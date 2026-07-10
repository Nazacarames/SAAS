"""CRUD de reglas comment-to-DM (comentario en IG/FB → mensaje directo)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db
from app.services.comment_automations import ensure_tables, ensure_page_feed_subscription

router = APIRouter(prefix="/comment-automations", tags=["comment-automations"])

_VALID_CHANNELS = {"instagram", "messenger"}


class AutomationUpsert(BaseModel):
    channel_type: str = Field(pattern="^(instagram|messenger)$")
    name: str = ""
    keywords: str = ""
    post_id: str = ""
    agent_generated: bool = True
    message_text: str = ""
    enabled: bool = True


def _company_id(payload: dict) -> int:
    cid = payload.get("companyId")
    if not cid:
        raise HTTPException(status_code=401, detail="Sin empresa en el token")
    return int(cid)


def _connected_channels(db: Session, company_id: int) -> dict:
    rows = db.execute(
        text("""SELECT channel_type FROM channels
                WHERE company_id = :cid AND status = 'active' AND channel_type IN ('instagram', 'messenger')"""),
        {"cid": company_id},
    ).mappings().all()
    types = {r["channel_type"] for r in rows}
    return {"instagram": "instagram" in types, "messenger": "messenger" in types}


def _row_out(r: dict) -> dict:
    return {
        "id": r["id"], "channel_type": r["channel_type"], "name": r["name"],
        "keywords": r["keywords"], "post_id": r["post_id"],
        "agent_generated": r["agent_generated"], "message_text": r["message_text"],
        "enabled": r["enabled"], "dm_count": r.get("dm_count", 0),
        "created_at": str(r.get("created_at") or ""),
    }


@router.get("")
def list_automations(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    cid = _company_id(payload)
    ensure_tables(db)
    rows = db.execute(
        text("""SELECT a.*, COALESCE(l.n, 0) AS dm_count
                FROM comment_automations a
                LEFT JOIN LATERAL (
                    SELECT COUNT(*) AS n FROM comment_dm_log
                    WHERE automation_id = a.id AND ok = true
                ) l ON TRUE
                WHERE a.company_id = :cid ORDER BY a.id ASC"""),
        {"cid": cid},
    ).mappings().all()
    return {"automations": [_row_out(dict(r)) for r in rows], "channels": _connected_channels(db, cid)}


@router.get("/log")
def recent_log(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    cid = _company_id(payload)
    ensure_tables(db)
    rows = db.execute(
        text("""SELECT channel_type, commenter_name, comment_text, dm_text, ok, error, created_at
                FROM comment_dm_log WHERE company_id = :cid
                ORDER BY id DESC LIMIT 30"""),
        {"cid": cid},
    ).mappings().all()
    return {"log": [{**dict(r), "created_at": str(r["created_at"])} for r in rows]}


async def _subscribe_if_needed(db: Session, cid: int, channel_type: str) -> str:
    """Para reglas de Facebook, asegura que la página esté suscripta al campo
    'feed' del webhook. Devuelve un warning legible si no se pudo."""
    if channel_type != "messenger":
        return ""
    from app.services.channels.registry import get_primary_channel
    channel = get_primary_channel(db, cid, "messenger")
    if not channel:
        return ""
    ok, err = await ensure_page_feed_subscription(db, channel)
    if not ok:
        return ("No se pudo suscribir la página a los comentarios automáticamente "
                f"({err}). Verificá los permisos de la conexión de Facebook.")
    return ""


@router.post("")
async def create_automation(
    body: AutomationUpsert,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    cid = _company_id(payload)
    ensure_tables(db)
    connected = _connected_channels(db, cid)
    if not connected.get(body.channel_type):
        raise HTTPException(status_code=400, detail=(
            "Primero conectá el canal de "
            + ("Instagram" if body.channel_type == "instagram" else "Facebook (Messenger)")
            + " en la sección Canales"))
    if not body.agent_generated and not body.message_text.strip():
        raise HTTPException(status_code=400, detail="Escribí el mensaje fijo o activá el modo agente")

    row = db.execute(
        text("""INSERT INTO comment_automations
                    (company_id, channel_type, name, keywords, post_id, agent_generated, message_text, enabled)
                VALUES (:cid, :ct, :name, :kw, :pid, :ag, :msg, :en)
                RETURNING *"""),
        {"cid": cid, "ct": body.channel_type, "name": body.name.strip()[:120],
         "kw": body.keywords.strip()[:1000], "pid": body.post_id.strip()[:120],
         "ag": body.agent_generated, "msg": body.message_text.strip()[:1500], "en": body.enabled},
    ).mappings().first()
    db.commit()
    warning = await _subscribe_if_needed(db, cid, body.channel_type)
    return {"ok": True, "automation": _row_out(dict(row)), "warning": warning or None}


@router.put("/{automation_id}")
async def update_automation(
    automation_id: int,
    body: AutomationUpsert,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    cid = _company_id(payload)
    ensure_tables(db)
    if not body.agent_generated and not body.message_text.strip():
        raise HTTPException(status_code=400, detail="Escribí el mensaje fijo o activá el modo agente")
    row = db.execute(
        text("""UPDATE comment_automations
                SET channel_type = :ct, name = :name, keywords = :kw, post_id = :pid,
                    agent_generated = :ag, message_text = :msg, enabled = :en, updated_at = NOW()
                WHERE id = :id AND company_id = :cid RETURNING *"""),
        {"id": automation_id, "cid": cid, "ct": body.channel_type, "name": body.name.strip()[:120],
         "kw": body.keywords.strip()[:1000], "pid": body.post_id.strip()[:120],
         "ag": body.agent_generated, "msg": body.message_text.strip()[:1500], "en": body.enabled},
    ).mappings().first()
    db.commit()
    if not row:
        raise HTTPException(status_code=404, detail="Regla no encontrada")
    warning = ""
    if body.enabled:
        warning = await _subscribe_if_needed(db, cid, body.channel_type)
    return {"ok": True, "automation": _row_out(dict(row)), "warning": warning or None}


@router.delete("/{automation_id}")
def delete_automation(
    automation_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    cid = _company_id(payload)
    ensure_tables(db)
    res = db.execute(
        text("DELETE FROM comment_automations WHERE id = :id AND company_id = :cid RETURNING id"),
        {"id": automation_id, "cid": cid},
    ).mappings().first()
    db.commit()
    if not res:
        raise HTTPException(status_code=404, detail="Regla no encontrada")
    return {"ok": True}
