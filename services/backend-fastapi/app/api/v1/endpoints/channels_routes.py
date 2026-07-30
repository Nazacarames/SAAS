import asyncio
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

    # Suscribir la app a los webhooks del activo: sin esto el canal queda
    # "conectado" pero Meta nunca envía los mensajes entrantes
    warnings: list[str] = []
    if body.access_token.strip():
        ok, detail = _subscribe_channel_webhooks(
            body.channel_type, body.external_id.strip(), body.access_token.strip())
        if not ok:
            warnings.append(f"El canal se creó pero no se pudieron activar los webhooks: {detail}. "
                            "Usá el botón Reparar en el canal.")
        elif row:
            cfg = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else (row["config_json"] or {})
            cfg["webhooksOk"] = True
            db.execute(text("UPDATE channels SET config_json = :c WHERE id = :id"),
                       {"c": json.dumps(cfg), "id": row["id"]})
            db.commit()

    _invalidate_channels_cache(company_id)
    return {"ok": True, "channel": dict(row) if row else None, "warnings": warnings}


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
    hard: bool = False,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Por defecto deshabilita (reversible). Con ?hard=true elimina el canal
    definitivamente, junto con su conexión de Meta si ningún otro canal la usa."""
    require_admin(payload)
    company_id = payload.get("companyId")
    ch = db.execute(
        text("SELECT id, meta_connection_id FROM channels WHERE id = :id AND company_id = :cid"),
        {"id": channel_id, "cid": company_id},
    ).mappings().first()
    if not ch:
        raise HTTPException(status_code=404, detail="Canal no encontrado")

    if hard:
        db.execute(text("DELETE FROM channels WHERE id = :id"), {"id": channel_id})
        if ch["meta_connection_id"]:
            in_use = db.execute(
                text("SELECT COUNT(*) FROM channels WHERE meta_connection_id = :mc"),
                {"mc": ch["meta_connection_id"]},
            ).scalar()
            if not in_use:
                db.execute(text("DELETE FROM meta_connections WHERE id = :mc"), {"mc": ch["meta_connection_id"]})
    else:
        db.execute(text("UPDATE channels SET status = 'disabled', updated_at = NOW() WHERE id = :id"), {"id": channel_id})
    db.commit()
    _invalidate_channels_cache(company_id)
    return {"ok": True, "deleted": hard}


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
    return await _discover_with_token(db, token)


async def _exchange_meta_code(code: str) -> str:
    """Canjea el code de OAuth/Embedded Signup por un access token."""
    app_id = os.getenv("META_APP_ID", "").strip()
    app_secret = os.getenv("META_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        raise HTTPException(status_code=500, detail="Falta configurar META_APP_ID/META_APP_SECRET")
    async with httpx.AsyncClient(timeout=25) as client:
        resp = await client.get(f"{GRAPH}/oauth/access_token", params={
            "client_id": app_id, "client_secret": app_secret, "code": code.strip(),
        })
    if resp.status_code != 200:
        err = (resp.json().get("error") or {}).get("message") or resp.text[:200]
        raise HTTPException(status_code=400, detail=f"Meta rechazó el código: {err}")
    token = resp.json().get("access_token") or ""
    if not token:
        raise HTTPException(status_code=400, detail="Meta no devolvió un token")
    return token


class OAuthDiscoverBody(BaseModel):
    code: str


@router.post("/oauth-discover")
async def oauth_discover(
    body: OAuthDiscoverBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Login con Meta (popup) para Instagram/Messenger: canjea el code y
    devuelve los activos conectables + el token para el wizard de selección."""
    require_admin(payload)
    if not body.code.strip():
        raise HTTPException(status_code=400, detail="Falta el code de Meta")
    token = await _exchange_meta_code(body.code)
    result = await _discover_with_token(db, token)
    result["token"] = token
    return result


# ── Descubrimiento y suscripción de webhooks ─────────────────────────
# Sin suscribir la app al activo (página o WABA), Meta NUNCA envía los
# mensajes entrantes: el canal se ve "conectado" y no llega nada. Es la
# causa #1 de "conecté el canal y no funciona".

_PAGE_WEBHOOK_FIELDS = ["messages", "messaging_postbacks", "messaging_optins",
                        "message_reactions", "messaging_referrals", "feed"]


def _paged(client: httpx.Client, url: str, params: dict, cap: int = 500) -> list[dict]:
    """GET siguiendo paging.next: sin esto se pierden activos a partir del
    primer lote (por qué 'hay números cargados que no aparecen')."""
    out: list[dict] = []
    try:
        resp = client.get(url, params={**params, "limit": 100})
        while resp.status_code == 200:
            data = resp.json()
            out.extend(data.get("data") or [])
            nxt = (data.get("paging") or {}).get("next")
            if not nxt or len(out) >= cap:
                break
            resp = client.get(nxt)
    except Exception:
        pass
    return out


def _all_business_ids(client: httpx.Client, token: str) -> list[str]:
    """Negocios alcanzables por el token: los propios y los de cada página.
    Un token de usuario del sistema suele devolver /me/businesses vacío, por
    eso hay que llegar también por las páginas."""
    ids: list[str] = []
    for b in _paged(client, f"{GRAPH}/me/businesses", {"access_token": token, "fields": "id"}):
        if b.get("id") and b["id"] not in ids:
            ids.append(b["id"])
    for p in _paged(client, f"{GRAPH}/me/accounts", {"access_token": token, "fields": "id"}):
        try:
            biz = (client.get(f"{GRAPH}/{p['id']}", params={"access_token": token, "fields": "business"})
                   .json().get("business") or {}).get("id")
            if biz and biz not in ids:
                ids.append(biz)
        except Exception:
            continue
    return ids


def _all_wabas(client: httpx.Client, token: str) -> list[dict]:
    """WABAs visibles: propios (owned) y compartidos con nosotros (client).
    Antes solo se miraban los owned de los negocios con página, así que los
    números de un WABA compartido o sin página nunca aparecían."""
    wabas: list[dict] = []
    seen: set[str] = set()
    for biz in _all_business_ids(client, token):
        for edge in ("owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"):
            for w in _paged(client, f"{GRAPH}/{biz}/{edge}", {"access_token": token, "fields": "id,name"}):
                if w.get("id") and w["id"] not in seen:
                    seen.add(w["id"])
                    wabas.append(w)
    return wabas


def _resolve_waba_for_phone(client: httpx.Client, phone_id: str, token: str) -> str:
    for waba in _all_wabas(client, token):
        for n in _paged(client, f"{GRAPH}/{waba['id']}/phone_numbers", {"access_token": token, "fields": "id"}):
            if n.get("id") == phone_id:
                return waba["id"]
    return ""


def _subscribe_channel_webhooks(channel_type: str, external_id: str, token: str,
                                waba_hint: str = "") -> tuple[bool, str]:
    """Suscribe la app a los webhooks del canal. Devuelve (ok, detalle)."""
    if not token:
        return False, "el canal no tiene token guardado"
    try:
        with httpx.Client(timeout=25) as client:
            if channel_type == "whatsapp":
                waba = waba_hint or _resolve_waba_for_phone(client, external_id, token)
                if not waba:
                    return False, "no se pudo identificar el WABA del número (revisá permisos whatsapp_business_management)"
                r = client.post(f"{GRAPH}/{waba}/subscribed_apps", headers={"Authorization": f"Bearer {token}"})
                return (r.status_code == 200), ("" if r.status_code == 200 else r.text[:150])

            # instagram y messenger se suscriben SIEMPRE sobre la página: con
            # token de página /me devuelve la página (para IG el external_id es
            # la cuenta de Instagram, no sirve como destino de la suscripción)
            page_id = external_id if channel_type == "messenger" else ""
            r = client.get(f"{GRAPH}/me", params={"access_token": token, "fields": "id"})
            if r.status_code == 200 and r.json().get("id"):
                page_id = r.json()["id"]
            if not page_id:
                return False, "no se pudo identificar la página (el token debería ser de la página)"

            current: list[str] = []
            r = client.get(f"{GRAPH}/{page_id}/subscribed_apps", params={"access_token": token})
            if r.status_code == 200:
                for app in (r.json().get("data") or []):
                    current.extend(app.get("subscribed_fields") or [])
            fields = sorted(set(current) | set(_PAGE_WEBHOOK_FIELDS))
            r = client.post(f"{GRAPH}/{page_id}/subscribed_apps",
                            params={"subscribed_fields": ",".join(fields)},
                            headers={"Authorization": f"Bearer {token}"})
            return (r.status_code == 200), ("" if r.status_code == 200 else r.text[:150])
    except Exception as e:
        return False, str(e)[:150]


def _channel_token(db: Session, channel_id: int) -> str:
    row = db.execute(
        text("""SELECT mc.access_token FROM channels c
                JOIN meta_connections mc ON mc.id = c.meta_connection_id WHERE c.id = :id"""),
        {"id": channel_id},
    ).scalar()
    return decrypt(row) if row else ""


async def _discover_with_token(db: Session, token: str) -> dict:
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
                page_token = p.get("access_token") or ""
                if not page_token:
                    # Los tokens de usuario del sistema a veces no traen el page token
                    # en /me/accounts: pedirlo explícito (sin él la mensajería falla)
                    try:
                        r2 = await client.get(f"{GRAPH}/{p['id']}", params={"access_token": token, "fields": "access_token"})
                        if r2.status_code == 200:
                            page_token = r2.json().get("access_token") or ""
                    except Exception:
                        pass
                pages.append({"id": p["id"], "name": p.get("name") or "", "access_token": page_token})
                ig = p.get("instagram_business_account")
                if ig:
                    instagram.append({
                        # page_token, no p["access_token"]: cuando /me/accounts no
                        # trae el token de página, Instagram quedaba sin token y
                        # el canal no podía ni recibir ni responder
                        "id": ig["id"], "username": ig.get("username") or "",
                        "page_name": p.get("name") or "", "access_token": page_token,
                    })
            if resp.status_code != 200:
                warnings.append("No se pudieron listar páginas de Facebook")
        except Exception:
            warnings.append("No se pudieron listar páginas de Facebook")

    # 3. Números de WhatsApp de TODOS los WABAs alcanzables (propios y
    #    compartidos, con paginación), no solo los de negocios con página
    def _scan_numbers() -> list[dict]:
        found, seen_phone = [], set()
        with httpx.Client(timeout=25) as c:
            for waba in _all_wabas(c, token):
                for num in _paged(c, f"{GRAPH}/{waba['id']}/phone_numbers",
                                  {"access_token": token,
                                   "fields": "id,display_phone_number,verified_name,quality_rating"}):
                    if not num.get("id") or num["id"] in seen_phone:
                        continue
                    seen_phone.add(num["id"])
                    found.append({
                        "id": num["id"],
                        "display_phone_number": num.get("display_phone_number") or "",
                        "verified_name": num.get("verified_name") or "",
                        "quality_rating": num.get("quality_rating") or "",
                        "waba_name": waba.get("name") or "",
                        "waba_id": waba["id"],
                    })
        return found

    try:
        whatsapp = await asyncio.to_thread(_scan_numbers)
    except Exception as e:
        whatsapp = []
        warnings.append(f"No se pudieron listar números de WhatsApp: {str(e)[:100]}")
    if not whatsapp:
        warnings.append("El token no da acceso a números de WhatsApp (revisá permisos whatsapp_business_management "
                        "y que el usuario del sistema tenga asignado el WABA)")

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
    # code puede faltar: con cookies de terceros bloqueadas FB.login no devuelve
    # authResponse aunque el cliente haya completado el popup. En ese caso el
    # frontend manda waba_id/phone_number_id (session info) y usamos el token
    # de sistema del proveedor (el WABA queda compartido con nuestro portfolio
    # al completar el Embedded Signup).
    code: str = ""
    waba_id: str = ""
    phone_number_id: str = ""


@router.get("/embedded-signup/config")
def embedded_signup_config(payload: dict = Depends(get_current_user_payload)):
    app_id = os.getenv("META_APP_ID", "").strip()
    config_id = os.getenv("META_ES_CONFIG_ID", "").strip()
    # Config de Facebook Login for Business (variación General) para conectar
    # Instagram/Messenger sin pasar por el registro de WhatsApp
    login_config_id = os.getenv("META_LOGIN_CONFIG_ID", "").strip() or config_id
    return {"app_id": app_id, "config_id": config_id, "login_config_id": login_config_id,
            "ready": bool(app_id and config_id)}


@router.post("/embedded-signup")
async def embedded_signup_connect(
    body: EmbeddedSignupBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    warnings: list[str] = []
    via_system_token = False
    if body.code.strip():
        token = await _exchange_meta_code(body.code)
    elif body.waba_id.strip():
        token = os.getenv("META_SYSTEM_TOKEN", "").strip()
        if not token:
            raise HTTPException(status_code=400, detail="Meta no devolvió la autorización y no hay token de sistema configurado")
        via_system_token = True
        # el ES completado comparte el WABA con nuestro portfolio; si no es
        # accesible, el registro no terminó y no hay que crear un canal roto
        async with httpx.AsyncClient(timeout=25) as client:
            chk = await client.get(f"{GRAPH}/{body.waba_id.strip()}", params={"access_token": token, "fields": "id,name"})
        if chk.status_code != 200:
            raise HTTPException(status_code=400, detail="Meta no devolvió la autorización y el WABA no quedó compartido con el proveedor. Repetí la conexión completando todos los pasos del popup")
        warnings.append("Meta no devolvió el code (¿cookies de terceros bloqueadas?); se conectó con el token del proveedor")
    else:
        raise HTTPException(status_code=400, detail="Meta no devolvió la autorización. Probá de nuevo permitiendo cookies de terceros, o usá 'Conectar con token'")
    async with httpx.AsyncClient(timeout=25) as client:
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

    # 6.5 Plantilla de aviso al asesor (la usa el Menú Bot como fallback fuera
    # de la ventana de 24 h). UTILITY: Meta la aprueba en minutos.
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            resp = await client.post(
                f"{GRAPH}/{waba_id}/message_templates",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "name": "nuevo_cliente", "language": "es_AR", "category": "UTILITY",
                    "components": [{
                        "type": "BODY",
                        "text": "🔔 Nuevo cliente por atender: *{{1}}*\nWhatsApp: {{2}}\nEntrá al CRM para ver la conversación.",
                        "example": {"body_text": [["Juan Pérez", "5491122334455"]]},
                    }],
                })
            if resp.status_code != 200:
                err = str((resp.json().get("error") or {}).get("message", ""))[:150] if "json" in resp.headers.get("content-type", "") else resp.text[:150]
                if "already exists" not in err.lower():
                    warnings.append(f"No se pudo crear la plantilla de aviso al asesor ({err}); creala desde Templates")
    except Exception:
        pass

    # El mismo token del registro da acceso a Páginas e Instagram del negocio:
    # los devolvemos para ofrecer conectarlos en el mismo paso. NUNCA en modo
    # fallback: ahí el token es el de sistema del proveedor y no debe viajar
    # al navegador del cliente.
    extra_assets = {"instagram": [], "messenger": [], "token": ""}
    if not via_system_token:
        extra_assets["token"] = token
        try:
            disc = await _discover_with_token(db, token)
            if disc.get("ok"):
                extra_assets["instagram"] = [a for a in disc.get("instagram", []) if not a.get("already_connected")]
                extra_assets["messenger"] = [a for a in disc.get("messenger", []) if not a.get("already_connected")]
        except Exception:
            pass

    return {"ok": True, "channel_id": channel_id, "phone": display, "name": channel_name,
            "waba_id": waba_id, "warnings": warnings, "extra_assets": extra_assets}


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


@router.get("/diagnose")
async def diagnose_channels(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Estado real de cada canal contra Meta: token vivo y webhooks suscriptos.
    Un canal 'activo' sin suscripción no recibe NINGÚN mensaje."""
    company_id = payload.get("companyId")
    rows = db.execute(
        text("""SELECT c.id, c.channel_type, c.name, c.external_id, c.status, c.config_json,
                       mc.access_token AS mc_token
                FROM channels c LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
                WHERE c.company_id = :cid ORDER BY c.id"""),
        {"cid": company_id},
    ).mappings().all()

    def _check(ch: dict) -> dict:
        token = decrypt(ch["mc_token"]) if ch["mc_token"] else ""
        out = {"id": ch["id"], "channel_type": ch["channel_type"], "name": ch["name"],
               "external_id": ch["external_id"], "status": ch["status"],
               "token_ok": False, "webhooks_ok": False, "problem": ""}
        if not token:
            out["problem"] = "El canal no tiene token guardado"
            return out
        try:
            with httpx.Client(timeout=20) as c:
                dbg = c.get(f"{GRAPH}/debug_token", params={"input_token": token, "access_token": token})
                data = dbg.json().get("data", {}) if dbg.status_code == 200 else {}
                out["token_ok"] = bool(data.get("is_valid"))
                if not out["token_ok"]:
                    out["problem"] = "El token venció o fue revocado: reconectá el canal"
                    return out
                if ch["channel_type"] == "whatsapp":
                    cfg = json.loads(ch["config_json"]) if isinstance(ch["config_json"], str) else (ch["config_json"] or {})
                    waba = cfg.get("wabaId") or _resolve_waba_for_phone(c, ch["external_id"], token)
                    if waba:
                        r = c.get(f"{GRAPH}/{waba}/subscribed_apps", params={"access_token": token})
                        out["webhooks_ok"] = r.status_code == 200 and bool(r.json().get("data"))
                else:
                    page_id = ch["external_id"] if ch["channel_type"] == "messenger" else ""
                    me = c.get(f"{GRAPH}/me", params={"access_token": token, "fields": "id"})
                    if me.status_code == 200 and me.json().get("id"):
                        page_id = me.json()["id"]
                    if page_id:
                        r = c.get(f"{GRAPH}/{page_id}/subscribed_apps", params={"access_token": token})
                        subs = (r.json().get("data") or []) if r.status_code == 200 else []
                        fields = {f for a in subs for f in (a.get("subscribed_fields") or [])}
                        out["webhooks_ok"] = "messages" in fields
        except Exception as e:
            out["problem"] = str(e)[:120]
            return out
        if not out["webhooks_ok"]:
            out["problem"] = "No recibe mensajes: falta suscribir los webhooks (tocá Reparar)"
        return out

    checks = await asyncio.to_thread(lambda: [_check(dict(r)) for r in rows])
    return {"ok": True, "channels": checks,
            "problems": len([c for c in checks if c["problem"]])}


@router.post("/{channel_id}/repair")
async def repair_channel(
    channel_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Vuelve a suscribir los webhooks del canal (arregla 'conectado pero no
    llegan mensajes' sin tener que reconectar de cero)."""
    require_admin(payload)
    company_id = payload.get("companyId")
    ch = db.execute(
        text("""SELECT c.id, c.channel_type, c.external_id, c.config_json, mc.access_token AS mc_token
                FROM channels c LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
                WHERE c.id = :id AND c.company_id = :cid"""),
        {"id": channel_id, "cid": company_id},
    ).mappings().first()
    if not ch:
        raise HTTPException(status_code=404, detail="Canal no encontrado")
    token = decrypt(ch["mc_token"]) if ch["mc_token"] else ""
    if not token:
        raise HTTPException(status_code=400, detail="El canal no tiene token: reconectalo desde Canales")

    cfg = json.loads(ch["config_json"]) if isinstance(ch["config_json"], str) else (ch["config_json"] or {})
    ok, detail = await asyncio.to_thread(
        _subscribe_channel_webhooks, ch["channel_type"], ch["external_id"], token, cfg.get("wabaId", ""))
    if ok:
        cfg["webhooksOk"] = True
        db.execute(text("UPDATE channels SET config_json = :c, status = 'active' WHERE id = :id"),
                   {"c": json.dumps(cfg), "id": channel_id})
        db.commit()
        _invalidate_channels_cache(company_id)
        return {"ok": True, "message": "Webhooks activados: el canal ya recibe mensajes"}
    raise HTTPException(status_code=400, detail=f"No se pudo activar: {detail}")


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
