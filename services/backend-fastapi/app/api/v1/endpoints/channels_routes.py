import json
import logging
import os
import secrets
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db
from app.services.crypto import decrypt, encrypt

router = APIRouter(prefix="/channels", tags=["channels"])
log = logging.getLogger("app.channels.routes")


def _get_company_verify_token(db: Session, company_id: int) -> str:
    """Return the company's existing webhook verify token, if any channel already has one,
    falling back to legacy company_runtime_settings tokens. Empty string if none."""
    rows = db.execute(
        text("SELECT config_json FROM channels WHERE company_id = :cid"),
        {"cid": company_id},
    ).mappings().all()
    for row in rows:
        try:
            cfg = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else (row["config_json"] or {})
            if cfg.get("verifyToken"):
                return cfg["verifyToken"]
        except Exception:
            continue

    # Legacy fallback: reuse existing per-company token from company_runtime_settings
    crs = db.execute(
        text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
        {"cid": company_id},
    ).mappings().first()
    if crs and crs["settings_json"]:
        try:
            s = json.loads(crs["settings_json"]) if isinstance(crs["settings_json"], str) else crs["settings_json"]
            return s.get("waCloudVerifyToken") or s.get("metaLeadAdsWebhookVerifyToken") or ""
        except Exception:
            pass
    return ""


def _invalidate_channels_cache(company_id: int) -> None:
    from app.services.cache import invalidate
    invalidate(f"channels_health:{company_id}")


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

    # One verify token per company: reuse the company's existing token (so the
    # single unified webhook URL in Meta uses one consistent token across all
    # channels). Generate a fresh random one only if the company has none yet.
    verify_token = body.verify_token.strip()
    if not verify_token:
        verify_token = _get_company_verify_token(db, company_id) or secrets.token_urlsafe(32)

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
                "token": encrypt(body.access_token.strip()),
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

    _invalidate_channels_cache(company_id)
    return {"ok": True, "channel": dict(row) if row else None}


# ── Recaptación automática (toggle por empresa en la página Templates) ─

_REENGAGE_TEMPLATE_NAME = "reenganche_agente"
_REENGAGE_TEMPLATE_BODY = ("Hola {{1}}! Soy el asistente de la inmobiliaria. {{2}} "
                           "Respondé este mensaje y seguimos por acá.")


def _reengage_template_status(creds: dict) -> str:
    """APPROVED | PENDING | REJECTED | missing"""
    try:
        resp = httpx.get(
            f"{GRAPH}/{creds['waba_id']}/message_templates",
            params={"access_token": creds["token"], "fields": "name,status", "limit": 100},
            timeout=15,
        )
        for t in (resp.json().get("data") or []):
            if t.get("name") == _REENGAGE_TEMPLATE_NAME:
                return t.get("status", "PENDING")
    except Exception:
        pass
    return "missing"


@router.get("/reengagement")
def reengagement_get(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    row = db.execute(
        text("SELECT ai_config_json FROM ai_agents WHERE company_id = :cid AND is_active = true ORDER BY id DESC LIMIT 1"),
        {"cid": company_id},
    ).mappings().first()
    cfg = {}
    if row and row["ai_config_json"]:
        try:
            cfg = (json.loads(row["ai_config_json"]) or {}).get("reengagement") or {}
        except Exception:
            cfg = {}
    creds = _wa_channel_creds(db, company_id)
    template_status = _reengage_template_status(creds) if creds else "missing"
    return {
        "ok": True,
        "enabled": bool(cfg.get("enabled")),
        "days": int(cfg.get("days", 3)),
        "has_agent": bool(row),
        "has_whatsapp": bool(creds),
        "template_status": template_status,
    }


class ReengagementUpdate(BaseModel):
    enabled: bool
    days: int | None = None


@router.put("/reengagement")
def reengagement_set(
    body: ReengagementUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    agent = db.execute(
        text("SELECT id, ai_config_json FROM ai_agents WHERE company_id = :cid AND is_active = true ORDER BY id DESC LIMIT 1"),
        {"cid": company_id},
    ).mappings().first()
    if not agent:
        raise HTTPException(status_code=400, detail="Primero activá un Agente IA (sección Agente IA)")

    template_created = False
    if body.enabled:
        creds = _wa_channel_creds(db, company_id)
        if not creds:
            raise HTTPException(status_code=400, detail="Necesitás un canal de WhatsApp activo para recaptar")
        # Si la empresa no tiene la plantilla de reenganche, se crea sola
        status = _reengage_template_status(creds)
        if status == "missing":
            resp = httpx.post(
                f"{GRAPH}/{creds['waba_id']}/message_templates",
                params={"access_token": creds["token"]},
                json={
                    "name": _REENGAGE_TEMPLATE_NAME, "language": "es_AR", "category": "MARKETING",
                    "components": [{
                        "type": "BODY", "text": _REENGAGE_TEMPLATE_BODY,
                        "example": {"body_text": [["Martina", "Estuviste buscando un depto en alquiler y esta semana entraron opciones nuevas. ¿Seguís buscando?"]]},
                    }],
                },
                timeout=25,
            )
            if resp.status_code != 200:
                err = resp.json().get("error", {}).get("message", "")[:200]
                raise HTTPException(status_code=502, detail=f"No se pudo crear la plantilla en Meta: {err}")
            template_created = True
            status = "PENDING"

    try:
        cfg = json.loads(agent["ai_config_json"]) if agent["ai_config_json"] else {}
    except Exception:
        cfg = {}
    ree = cfg.get("reengagement") or {}
    ree.update({
        "enabled": body.enabled,
        "days": max(1, min(int(body.days or ree.get("days", 3)), 30)),
        "max_wait_days": ree.get("max_wait_days", 14),
        "agent_generated": True,
        "template_name": _REENGAGE_TEMPLATE_NAME,
        "template_lang": ree.get("template_lang", "es_AR"),
        "template_body": _REENGAGE_TEMPLATE_BODY,
    })
    cfg["reengagement"] = ree
    db.execute(
        text("UPDATE ai_agents SET ai_config_json = :c, updated_at = NOW() WHERE id = :id"),
        {"c": json.dumps(cfg, ensure_ascii=False), "id": agent["id"]},
    )
    db.commit()
    try:
        from app.services.cache import invalidate
        invalidate(f"agent_cfg:{company_id}")
    except Exception:
        pass
    return {"ok": True, "enabled": body.enabled, "template_created": template_created}


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
                {"token": encrypt(body.access_token.strip()), "mcid": mc_id},
            )
        else:
            result = db.execute(
                text(
                    """INSERT INTO meta_connections (company_id, access_token, phone_number_id, page_id, status, scopes_json, created_at, updated_at)
                       VALUES (:cid, :token, :phone, :page, 'connected', '[]', NOW(), NOW()) RETURNING id"""
                ),
                {
                    "cid": company_id,
                    "token": encrypt(body.access_token.strip()),
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

    _invalidate_channels_cache(company_id)
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
    _invalidate_channels_cache(company_id)
    return {"ok": True}


class DiscoverRequest(BaseModel):
    access_token: str


GRAPH = "https://graph.facebook.com/v21.0"


@router.post("/discover")
async def discover_assets(
    body: DiscoverRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Assisted connection: given ONE Meta token, enumerate every connectable
    asset (WhatsApp phone numbers, Instagram accounts, Facebook pages) so the
    user picks from a list instead of hunting IDs in Meta Developers."""
    require_admin(payload)
    token = body.access_token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="access_token es requerido")

    warnings: list[str] = []
    async with httpx.AsyncClient(timeout=15) as client:
        # 1. Validate the token
        try:
            resp = await client.get(f"{GRAPH}/debug_token", params={"input_token": token, "access_token": token})
            dbg = resp.json().get("data", {}) if resp.status_code == 200 else {}
        except Exception as e:
            return {"ok": False, "error": f"No se pudo contactar a Meta: {str(e)[:120]}"}
        if not dbg.get("is_valid"):
            err = (resp.json().get("error") or {}).get("message") or "Token inválido o vencido"
            return {"ok": False, "error": err}

        expires_at = dbg.get("expires_at") or 0
        token_info = {
            "type": dbg.get("type") or "",
            "expires_at": expires_at,  # 0 = never (system user)
            "never_expires": expires_at == 0,
            "app_id": dbg.get("app_id") or "",
        }

        # 2. Pages (Messenger) + linked Instagram accounts + per-page tokens
        pages, instagram = [], []
        try:
            resp = await client.get(
                f"{GRAPH}/me/accounts",
                params={"access_token": token, "limit": 100,
                        "fields": "id,name,access_token,instagram_business_account{id,username}"},
            )
            for p in (resp.json().get("data") or []) if resp.status_code == 200 else []:
                pages.append({"id": p["id"], "name": p.get("name") or "", "access_token": p.get("access_token") or ""})
                ig = p.get("instagram_business_account")
                if ig:
                    instagram.append({
                        "id": ig["id"], "username": ig.get("username") or "",
                        "page_name": p.get("name") or "", "access_token": p.get("access_token") or "",
                    })
            if resp.status_code != 200:
                warnings.append("No se pudieron listar páginas de Facebook")
        except Exception:
            warnings.append("No se pudieron listar páginas de Facebook")

        # 3. WhatsApp numbers: page → business → owned WABAs → phone_numbers
        whatsapp = []
        seen_biz, seen_phone = set(), set()
        for p in pages:
            try:
                resp = await client.get(f"{GRAPH}/{p['id']}", params={"access_token": token, "fields": "business"})
                biz = (resp.json().get("business") or {}).get("id") if resp.status_code == 200 else None
                if not biz or biz in seen_biz:
                    continue
                seen_biz.add(biz)
                resp = await client.get(
                    f"{GRAPH}/{biz}/owned_whatsapp_business_accounts",
                    params={"access_token": token, "limit": 50, "fields": "id,name"},
                )
                for waba in (resp.json().get("data") or []) if resp.status_code == 200 else []:
                    resp2 = await client.get(
                        f"{GRAPH}/{waba['id']}/phone_numbers",
                        params={"access_token": token,
                                "fields": "id,display_phone_number,verified_name,quality_rating"},
                    )
                    for num in (resp2.json().get("data") or []) if resp2.status_code == 200 else []:
                        if num["id"] in seen_phone:
                            continue
                        seen_phone.add(num["id"])
                        whatsapp.append({
                            "id": num["id"],
                            "display_phone_number": num.get("display_phone_number") or "",
                            "verified_name": num.get("verified_name") or "",
                            "quality_rating": num.get("quality_rating") or "",
                            "waba_name": waba.get("name") or "",
                        })
            except Exception:
                continue
        if pages and not whatsapp:
            warnings.append("El token no da acceso a números de WhatsApp (revisá permisos whatsapp_business_management)")

    # 4. Flag assets already registered as channels
    existing = {
        (r["channel_type"], r["external_id"])
        for r in db.execute(text("SELECT channel_type, external_id FROM channels WHERE status = 'active'")).mappings()
    }
    for w in whatsapp:
        w["already_connected"] = ("whatsapp", w["id"]) in existing
    for ig in instagram:
        ig["already_connected"] = ("instagram", ig["id"]) in existing
    for p in pages:
        p["already_connected"] = ("messenger", p["id"]) in existing

    return {"ok": True, "token_info": token_info, "whatsapp": whatsapp,
            "instagram": instagram, "messenger": pages, "warnings": warnings}


# ── Embedded Signup de WhatsApp (Tech Provider) ──────────────────────
# El cliente conecta su WhatsApp con el popup oficial de Meta: el frontend
# corre FB.login con la configuración de Embedded Signup y nos manda el
# code + waba_id + phone_number_id. Acá canjeamos el code por el business
# token, suscribimos la app al WABA (webhooks), registramos el número en
# la Cloud API y dejamos el canal creado.

class EmbeddedSignupBody(BaseModel):
    code: str
    waba_id: str = ""
    phone_number_id: str = ""


@router.get("/embedded-signup/config")
def embedded_signup_config(payload: dict = Depends(get_current_user_payload)):
    app_id = os.getenv("META_APP_ID", "").strip()
    config_id = os.getenv("META_ES_CONFIG_ID", "").strip()
    return {"app_id": app_id, "config_id": config_id, "ready": bool(app_id and config_id)}


@router.post("/embedded-signup")
async def embedded_signup_connect(
    body: EmbeddedSignupBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    app_id = os.getenv("META_APP_ID", "").strip()
    app_secret = os.getenv("META_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        raise HTTPException(status_code=500, detail="Falta configurar META_APP_ID/META_APP_SECRET")
    if not body.code.strip():
        raise HTTPException(status_code=400, detail="Falta el code de Meta")

    warnings: list[str] = []
    async with httpx.AsyncClient(timeout=25) as client:
        # 1. code → business token
        resp = await client.get(f"{GRAPH}/oauth/access_token", params={
            "client_id": app_id, "client_secret": app_secret, "code": body.code.strip(),
        })
        if resp.status_code != 200:
            err = (resp.json().get("error") or {}).get("message") or resp.text[:200]
            raise HTTPException(status_code=400, detail=f"Meta rechazó el código: {err}")
        token = resp.json().get("access_token") or ""
        if not token:
            raise HTTPException(status_code=400, detail="Meta no devolvió un token")

        # 2. Resolver WABA/número si el popup no los informó
        waba_id = body.waba_id.strip()
        phone_id = body.phone_number_id.strip()
        if not waba_id:
            resp = await client.get(f"{GRAPH}/me/businesses", params={"access_token": token, "limit": 5})
            for biz in (resp.json().get("data") or []) if resp.status_code == 200 else []:
                r2 = await client.get(f"{GRAPH}/{biz['id']}/owned_whatsapp_business_accounts",
                                      params={"access_token": token, "limit": 5})
                wabas = (r2.json().get("data") or []) if r2.status_code == 200 else []
                if wabas:
                    waba_id = wabas[0]["id"]
                    break
        if waba_id and not phone_id:
            resp = await client.get(f"{GRAPH}/{waba_id}/phone_numbers", params={"access_token": token})
            nums = (resp.json().get("data") or []) if resp.status_code == 200 else []
            if nums:
                phone_id = nums[0]["id"]
        if not waba_id or not phone_id:
            raise HTTPException(status_code=400, detail="No se pudo identificar el WABA o el número de WhatsApp")

        # 3. Suscribir la app al WABA (para que lleguen los webhooks)
        resp = await client.post(f"{GRAPH}/{waba_id}/subscribed_apps",
                                 headers={"Authorization": f"Bearer {token}"})
        if resp.status_code != 200:
            warnings.append(f"No se pudo suscribir la app al WABA: {resp.text[:120]}")

        # 4. Datos del número para nombrar el canal
        display, verified_name = "", ""
        resp = await client.get(f"{GRAPH}/{phone_id}",
                                params={"access_token": token,
                                        "fields": "display_phone_number,verified_name"})
        if resp.status_code == 200:
            display = resp.json().get("display_phone_number") or ""
            verified_name = resp.json().get("verified_name") or ""

        # 5. Registrar el número en la Cloud API (necesario para enviar)
        pin = f"{secrets.randbelow(1000000):06d}"
        resp = await client.post(f"{GRAPH}/{phone_id}/register",
                                 headers={"Authorization": f"Bearer {token}"},
                                 json={"messaging_product": "whatsapp", "pin": pin})
        registered = resp.status_code == 200 and (resp.json() or {}).get("success")
        if not registered:
            err = (resp.json().get("error") or {}).get("message") if "json" in resp.headers.get("content-type", "") else resp.text[:120]
            warnings.append(f"El número quedó conectado pero no se pudo registrar en la Cloud API: {err}. "
                            "Si ya estaba registrado, ignorá este aviso.")

    # 6. Canal + conexión (si ya existía para esta empresa, renovar token)
    existing = db.execute(
        text("SELECT id, company_id, meta_connection_id FROM channels WHERE channel_type = 'whatsapp' AND external_id = :eid"),
        {"eid": phone_id},
    ).mappings().first()
    if existing and int(existing["company_id"]) != int(company_id):
        raise HTTPException(status_code=409, detail="Ese número ya está conectado en otra cuenta")

    verify_token = _get_company_verify_token(db, company_id) or secrets.token_urlsafe(32)
    config = {"verifyToken": verify_token, "wabaId": waba_id, "registerPin": pin,
              "connectedVia": "embedded_signup"}
    channel_name = verified_name or display or "WhatsApp"

    if existing:
        if existing["meta_connection_id"]:
            db.execute(text("UPDATE meta_connections SET access_token = :t, status = 'connected', updated_at = NOW() WHERE id = :id"),
                       {"t": encrypt(token), "id": existing["meta_connection_id"]})
        db.execute(text("UPDATE channels SET name = :n, config_json = :cfg, status = 'active' WHERE id = :id"),
                   {"n": channel_name, "cfg": json.dumps(config), "id": existing["id"]})
        db.commit()
        channel_id = existing["id"]
    else:
        mc_id = db.execute(
            text("""INSERT INTO meta_connections (company_id, access_token, phone_number_id, page_id, status, scopes_json, created_at, updated_at)
                    VALUES (:cid, :token, :phone, '', 'connected', '[]', NOW(), NOW()) RETURNING id"""),
            {"cid": company_id, "token": encrypt(token), "phone": phone_id},
        ).scalar()
        channel_id = db.execute(
            text("""INSERT INTO channels (company_id, channel_type, name, external_id, meta_connection_id, config_json, status)
                    VALUES (:cid, 'whatsapp', :name, :eid, :mc, :cfg, 'active') RETURNING id"""),
            {"cid": company_id, "name": channel_name, "eid": phone_id, "mc": mc_id, "cfg": json.dumps(config)},
        ).scalar()
        db.commit()

    # webhook routing por phone_number_id (company_runtime_settings)
    try:
        runtime_row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid"), {"cid": company_id}
        ).scalar()
        s = json.loads(runtime_row) if runtime_row else {}
        s["waCloudPhoneNumberId"] = phone_id
        s.setdefault("waCloudWabaId", waba_id)
        if runtime_row is None:
            db.execute(text("INSERT INTO company_runtime_settings (company_id, settings_json) VALUES (:cid, :s)"),
                       {"cid": company_id, "s": json.dumps(s)})
        else:
            db.execute(text("UPDATE company_runtime_settings SET settings_json = :s WHERE company_id = :cid"),
                       {"s": json.dumps(s), "cid": company_id})
        db.commit()
    except Exception:
        db.rollback()
        warnings.append("No se pudo guardar el routing del webhook (waCloudPhoneNumberId)")

    _invalidate_channels_cache(company_id)
    return {"ok": True, "channel_id": channel_id, "phone": display, "name": channel_name,
            "waba_id": waba_id, "warnings": warnings}


# ── Templates de WhatsApp (Meta message_templates) ───────────────────
# La página Templates del panel gestiona directamente los templates del
# WABA: crear, editar (vuelve a revisión de Meta), borrar y ver estado.

def _wa_channel_creds(db: Session, company_id: int) -> dict | None:
    """Token + phone_number_id + waba_id del canal WhatsApp activo.
    El waba_id se resuelve una vez (phone → business → WABAs) y se cachea
    en channels.config_json."""
    ch = db.execute(
        text("""SELECT c.id, c.external_id, c.config_json, mc.access_token AS mc_token
                FROM channels c LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
                WHERE c.company_id = :cid AND c.channel_type = 'whatsapp' AND c.status = 'active'
                ORDER BY c.id LIMIT 1"""),
        {"cid": company_id},
    ).mappings().first()
    if not ch:
        return None
    token = decrypt(ch.get("mc_token")) or ""
    if not token:
        return None
    cfg = json.loads(ch["config_json"]) if isinstance(ch["config_json"], str) else (ch["config_json"] or {})
    waba_id = cfg.get("wabaId", "")

    if not waba_id:
        try:
            with httpx.Client(timeout=15) as client:
                pages = client.get(f"{GRAPH}/me/accounts", params={"access_token": token, "fields": "id", "limit": 50}).json().get("data", [])
                seen_biz = set()
                for p in pages:
                    biz = (client.get(f"{GRAPH}/{p['id']}", params={"access_token": token, "fields": "business"}).json().get("business") or {}).get("id")
                    if not biz or biz in seen_biz:
                        continue
                    seen_biz.add(biz)
                    for waba in client.get(f"{GRAPH}/{biz}/owned_whatsapp_business_accounts", params={"access_token": token, "fields": "id", "limit": 50}).json().get("data", []):
                        nums = client.get(f"{GRAPH}/{waba['id']}/phone_numbers", params={"access_token": token, "fields": "id"}).json().get("data", [])
                        if any(n["id"] == ch["external_id"] for n in nums):
                            waba_id = waba["id"]
                            break
                    if waba_id:
                        break
        except Exception:
            pass
        if waba_id:
            cfg["wabaId"] = waba_id
            db.execute(text("UPDATE channels SET config_json = :cfg, updated_at = NOW() WHERE id = :id"),
                       {"cfg": json.dumps(cfg), "id": ch["id"]})
            db.commit()

    if not waba_id:
        return None
    return {"token": token, "phone_number_id": ch["external_id"], "waba_id": waba_id}


class WabaTemplateBody(BaseModel):
    name: str = ""              # requerido al crear; slug minúsculas/guión bajo
    category: str = "MARKETING"  # MARKETING | UTILITY
    language: str = "es_AR"
    body: str = ""               # texto con variables {{1}}, {{2}}...
    footer: str = ""
    example_params: list[str] = []  # un ejemplo por variable (Meta lo exige para aprobar)


def _components(body: WabaTemplateBody) -> list:
    comp: list = [{"type": "BODY", "text": body.body}]
    if body.example_params:
        comp[0]["example"] = {"body_text": [body.example_params]}
    if body.footer.strip():
        comp.append({"type": "FOOTER", "text": body.footer.strip()})
    return comp


@router.get("/waba-templates")
def waba_templates_list(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    creds = _wa_channel_creds(db, company_id)
    if not creds:
        return {"ok": False, "error": "No hay canal de WhatsApp activo con token válido"}
    resp = httpx.get(
        f"{GRAPH}/{creds['waba_id']}/message_templates",
        params={"access_token": creds["token"], "fields": "id,name,status,category,language,components,rejected_reason", "limit": 100},
        timeout=20,
    )
    if resp.status_code != 200:
        return {"ok": False, "error": resp.json().get("error", {}).get("message", "")[:200]}
    out = []
    for t in resp.json().get("data", []):
        body_txt, footer_txt = "", ""
        for c in t.get("components", []):
            if c.get("type") == "BODY":
                body_txt = c.get("text", "")
            elif c.get("type") == "FOOTER":
                footer_txt = c.get("text", "")
        out.append({
            "id": t.get("id"), "name": t.get("name"), "status": t.get("status"),
            "category": t.get("category"), "language": t.get("language"),
            "body": body_txt, "footer": footer_txt,
            "rejected_reason": t.get("rejected_reason") or "",
        })
    return {"ok": True, "waba_id": creds["waba_id"], "templates": out}


@router.post("/waba-templates")
def waba_templates_create(
    body: WabaTemplateBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    name = body.name.strip().lower().replace(" ", "_")
    if not name or not body.body.strip():
        raise HTTPException(status_code=400, detail="name y body son requeridos")
    if body.category not in ("MARKETING", "UTILITY"):
        raise HTTPException(status_code=400, detail="category debe ser MARKETING o UTILITY")
    creds = _wa_channel_creds(db, company_id)
    if not creds:
        raise HTTPException(status_code=400, detail="No hay canal de WhatsApp activo")
    resp = httpx.post(
        f"{GRAPH}/{creds['waba_id']}/message_templates",
        params={"access_token": creds["token"]},
        json={"name": name, "language": body.language, "category": body.category, "components": _components(body)},
        timeout=25,
    )
    data = resp.json()
    if resp.status_code != 200:
        raise HTTPException(status_code=400, detail=data.get("error", {}).get("message", "Meta rechazó la creación")[:250])
    return {"ok": True, "id": data.get("id"), "status": data.get("status", "PENDING"), "name": name}


@router.put("/waba-templates/{template_id}")
def waba_templates_update(
    template_id: str,
    body: WabaTemplateBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Editar un template existente. Meta no permite editar PENDING; un
    APPROVED editado vuelve a revisión."""
    require_admin(payload)
    company_id = payload.get("companyId")
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="body es requerido")
    creds = _wa_channel_creds(db, company_id)
    if not creds:
        raise HTTPException(status_code=400, detail="No hay canal de WhatsApp activo")
    resp = httpx.post(
        f"{GRAPH}/{template_id}",
        params={"access_token": creds["token"]},
        json={"components": _components(body)},
        timeout=25,
    )
    data = resp.json()
    if resp.status_code != 200 or not data.get("success"):
        raise HTTPException(status_code=400, detail=data.get("error", {}).get("message", "Meta rechazó la edición")[:250])
    return {"ok": True}


@router.delete("/waba-templates/{name}")
def waba_templates_delete(
    name: str,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    creds = _wa_channel_creds(db, company_id)
    if not creds:
        raise HTTPException(status_code=400, detail="No hay canal de WhatsApp activo")
    resp = httpx.delete(
        f"{GRAPH}/{creds['waba_id']}/message_templates",
        params={"access_token": creds["token"], "name": name},
        timeout=20,
    )
    data = resp.json()
    if resp.status_code != 200 or not data.get("success"):
        raise HTTPException(status_code=400, detail=data.get("error", {}).get("message", "Meta rechazó el borrado")[:250])
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
    token = decrypt(ch.get("mc_token")) or cfg.get("waCloudAccessToken") or ""
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


@router.get("/health")
async def channels_health(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Token health for THIS company's channels only (scoped — never leaks other tenants).
    Cached 60s per company: every check hits the Meta Graph API per channel."""
    company_id = payload.get("companyId")

    from app.services.cache import peek, put
    _ck = f"channels_health:{company_id}"
    _hit = peek(_ck)
    if _hit is not None:
        return _hit

    rows = db.execute(
        text(
            """SELECT c.id, c.name, c.company_id, c.channel_type, c.external_id,
                      c.config_json, mc.access_token AS mc_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.company_id = :cid AND c.status = 'active'
               ORDER BY c.id"""
        ),
        {"cid": company_id},
    ).mappings().all()

    results = []
    for r in rows:
        try:
            cfg = json.loads(r["config_json"]) if isinstance(r["config_json"], str) else (r["config_json"] or {})
        except Exception:
            cfg = {}
        token = decrypt(r.get("mc_token")) or cfg.get("waCloudAccessToken") or ""
        external_id = r["external_id"]
        ctype = r["channel_type"]
        base = {"companyId": r["company_id"], "name": r["name"], "channel_type": ctype, "external_id": external_id}

        if not token or not external_id:
            results.append({**base, "status": "not_configured", "detail": "Token o ID no configurado"})
            continue

        fields = {"whatsapp": "display_phone_number,verified_name", "instagram": "name,username", "messenger": "name,category"}.get(ctype, "name")
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"https://graph.facebook.com/v21.0/{external_id}", params={"access_token": token, "fields": fields}, timeout=8)
            if resp.status_code == 200:
                results.append({**base, "status": "valid"})
            else:
                ed = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                code = ed.get("error", {}).get("code", resp.status_code)
                results.append({**base, "status": "expired" if code == 190 else "error", "detail": ed.get("error", {}).get("message", "")[:120], "error_code": code})
        except Exception as e:
            results.append({**base, "status": "unreachable", "detail": str(e)[:120]})

    all_valid = all(r["status"] == "valid" for r in results) if results else True
    resp = {"status": "ok" if all_valid else "warning", "tokens": results}
    put(_ck, 60, resp)
    return resp
