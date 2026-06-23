import json
import logging
import secrets
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db

router = APIRouter(prefix="/channels", tags=["channels"])
log = logging.getLogger("app.channels.routes")


class ChannelCreate(BaseModel):
    channel_type: str
    name: str
    external_id: str
    access_token: str = ""
    app_secret: str = ""
    verify_token: str = ""


class ChannelUpdate(BaseModel):
    name: str | None = None
    status: str | None = None
    access_token: str | None = None
    app_secret: str | None = None
    external_id: str | None = None


@router.get("")
def list_channels(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    rows = db.execute(
        text(
            """SELECT c.id, c.company_id, c.channel_type, c.name, c.status,
                      c.external_id, c.config_json, c.meta_connection_id,
                      c.created_at, c.updated_at
               FROM channels c
               WHERE c.company_id = :cid
               ORDER BY c.channel_type, c.id"""
        ),
        {"cid": company_id},
    ).mappings().all()

    channels = []
    for r in rows:
        d = dict(r)
        cfg = json.loads(d.pop("config_json", "{}")) if isinstance(d.get("config_json"), str) else d.pop("config_json", {})
        d["has_token"] = bool(d.get("meta_connection_id"))
        d["verify_token"] = cfg.get("verifyToken", "")
        channels.append(d)

    return {"ok": True, "channels": channels}


@router.post("")
def create_channel(
    body: ChannelCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    if body.channel_type not in ("whatsapp", "instagram", "messenger"):
        raise HTTPException(status_code=400, detail="channel_type debe ser whatsapp, instagram o messenger")
    if not body.external_id.strip():
        raise HTTPException(status_code=400, detail="external_id es requerido")

    existing = db.execute(
        text("SELECT id FROM channels WHERE channel_type = :ct AND external_id = :eid"),
        {"ct": body.channel_type, "eid": body.external_id.strip()},
    ).mappings().first()
    if existing:
        raise HTTPException(status_code=409, detail="Este canal ya está registrado")

    verify_token = body.verify_token.strip() or secrets.token_urlsafe(32)

    mc_id = None
    if body.access_token.strip():
        result = db.execute(
            text(
                """INSERT INTO meta_connections (company_id, access_token, phone_number_id, page_id, status, scopes_json, created_at, updated_at)
                   VALUES (:cid, :token, :phone, :page, 'connected', '[]', NOW(), NOW())
                   RETURNING id"""
            ),
            {
                "cid": company_id,
                "token": body.access_token.strip(),
                "phone": body.external_id.strip() if body.channel_type == "whatsapp" else "",
                "page": body.external_id.strip() if body.channel_type in ("messenger", "instagram") else "",
            },
        )
        mc_row = result.mappings().first()
        if mc_row:
            mc_id = mc_row["id"]
        db.commit()

    config = {"verifyToken": verify_token}
    if body.app_secret.strip():
        config["appSecret"] = body.app_secret.strip()

    db.execute(
        text(
            """INSERT INTO channels (company_id, channel_type, name, external_id, meta_connection_id, config_json, status)
               VALUES (:cid, :ct, :name, :eid, :mc, :cfg, 'active')"""
        ),
        {
            "cid": company_id,
            "ct": body.channel_type,
            "name": body.name.strip() or body.channel_type.capitalize(),
            "eid": body.external_id.strip(),
            "mc": mc_id,
            "cfg": json.dumps(config),
        },
    )
    db.commit()

    row = db.execute(
        text("SELECT * FROM channels WHERE company_id = :cid AND channel_type = :ct AND external_id = :eid"),
        {"cid": company_id, "ct": body.channel_type, "eid": body.external_id.strip()},
    ).mappings().first()

    return {"ok": True, "channel": dict(row) if row else None}


@router.put("/{channel_id}")
def update_channel(
    channel_id: int,
    body: ChannelUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    ch = db.execute(
        text("SELECT * FROM channels WHERE id = :id AND company_id = :cid"),
        {"id": channel_id, "cid": company_id},
    ).mappings().first()
    if not ch:
        raise HTTPException(status_code=404, detail="Canal no encontrado")

    updates = []
    params: dict = {"id": channel_id}

    if body.name is not None:
        updates.append("name = :name")
        params["name"] = body.name.strip()
    if body.status is not None:
        updates.append("status = :status")
        params["status"] = body.status
    if body.external_id is not None:
        updates.append("external_id = :eid")
        params["eid"] = body.external_id.strip()

    if body.access_token is not None and body.access_token.strip():
        mc_id = ch["meta_connection_id"]
        if mc_id:
            db.execute(
                text("UPDATE meta_connections SET access_token = :token, updated_at = NOW() WHERE id = :mcid"),
                {"token": body.access_token.strip(), "mcid": mc_id},
            )
        else:
            result = db.execute(
                text(
                    """INSERT INTO meta_connections (company_id, access_token, phone_number_id, page_id, status, scopes_json, created_at, updated_at)
                       VALUES (:cid, :token, :phone, :page, 'connected', '[]', NOW(), NOW()) RETURNING id"""
                ),
                {
                    "cid": company_id,
                    "token": body.access_token.strip(),
                    "phone": ch["external_id"] if ch["channel_type"] == "whatsapp" else "",
                    "page": ch["external_id"] if ch["channel_type"] in ("messenger", "instagram") else "",
                },
            )
            new_mc = result.mappings().first()
            if new_mc:
                updates.append("meta_connection_id = :mcid_new")
                params["mcid_new"] = new_mc["id"]
        db.commit()

    if body.app_secret is not None and body.app_secret.strip():
        cfg = json.loads(ch["config_json"]) if isinstance(ch["config_json"], str) else {}
        cfg["appSecret"] = body.app_secret.strip()
        updates.append("config_json = :cfg")
        params["cfg"] = json.dumps(cfg)

    if updates:
        updates.append("updated_at = NOW()")
        db.execute(text(f"UPDATE channels SET {', '.join(updates)} WHERE id = :id"), params)
        db.commit()

    return {"ok": True}


@router.delete("/{channel_id}")
def delete_channel(
    channel_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    ch = db.execute(
        text("SELECT id FROM channels WHERE id = :id AND company_id = :cid"),
        {"id": channel_id, "cid": company_id},
    ).mappings().first()
    if not ch:
        raise HTTPException(status_code=404, detail="Canal no encontrado")

    db.execute(text("UPDATE channels SET status = 'disabled', updated_at = NOW() WHERE id = :id"), {"id": channel_id})
    db.commit()
    return {"ok": True}


@router.post("/{channel_id}/test")
async def test_channel(
    channel_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    ch = db.execute(
        text(
            """SELECT c.*, mc.access_token AS mc_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.id = :id AND c.company_id = :cid"""
        ),
        {"id": channel_id, "cid": company_id},
    ).mappings().first()
    if not ch:
        raise HTTPException(status_code=404, detail="Canal no encontrado")

    cfg = json.loads(ch["config_json"]) if isinstance(ch["config_json"], str) else {}
    token = ch.get("mc_token") or cfg.get("waCloudAccessToken") or ""
    external_id = ch["external_id"]

    if not token:
        return {"ok": False, "error": "No hay access token configurado"}

    try:
        if ch["channel_type"] == "whatsapp":
            url = f"https://graph.facebook.com/v21.0/{external_id}"
            params = {"fields": "display_phone_number,verified_name,quality_rating", "access_token": token}
        elif ch["channel_type"] == "instagram":
            url = f"https://graph.facebook.com/v21.0/{external_id}"
            params = {"fields": "name,username,profile_picture_url", "access_token": token}
        elif ch["channel_type"] == "messenger":
            url = f"https://graph.facebook.com/v21.0/{external_id}"
            params = {"fields": "name,category,access_token", "access_token": token}
        else:
            return {"ok": False, "error": "Tipo de canal no soportado"}

        async with httpx.AsyncClient() as client:
            resp = await client.get(url, params=params, timeout=10)

        if resp.status_code == 200:
            data = resp.json()
            return {"ok": True, "data": data}
        else:
            error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            msg = error_data.get("error", {}).get("message", resp.text[:200])
            return {"ok": False, "error": msg, "status": resp.status_code}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
