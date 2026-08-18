"""
Integration Routes - External integrations (Tokko, etc.)
Migrated from Node.js integrationRoutes
"""
import os
import requests
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db
from app.core.config import settings

router = APIRouter(prefix="/integrations", tags=["integrations"])


# Optional auth dependency - returns None if no valid token
def optional_auth(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    try:
        from jose import jwt, JWTError
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except:
        return None


# --- Schemas ---
class LeadInput(BaseModel):
    name: str
    phone: str
    email: str = ""
    source: str = "web"
    message: str = ""
    tags: List[str] = []


class OutboundMessageInput(BaseModel):
    phone: str
    body: str
    contact_id: Optional[int] = None


class PropertySearchInput(BaseModel):
    location: Optional[str] = ""
    price_min: Optional[int] = None
    price_max: Optional[int] = None
    property_type: Optional[str] = ""
    rooms: Optional[int] = None
    limit: int = 5


# --- Tokko Integration ---
def get_tokko_credentials(company_id: int = None, db: Session = None) -> Optional[dict]:
    if company_id is None or int(company_id) <= 0:
        raise ValueError("company_id is required (multi-tenant safety)")
    """Get Tokko credentials for a specific company. Checks DB first, falls back to env vars."""
    if db and company_id:
        try:
            row = db.execute(
                text("SELECT tokko_api_key, tokko_base_url FROM companies WHERE id = :cid LIMIT 1"),
                {"cid": company_id}
            ).mappings().first()
            if row and row.get("tokko_api_key"):
                return {
                    "api_url": (row.get("tokko_base_url") or "https://www.tokkobroker.com/api/v1").rstrip("/"),
                    "api_key": row["tokko_api_key"],
                }
        except Exception:
            pass
    # Fallback to env vars (only if no per-company key found)
    if settings.tokko_api_url and settings.tokko_api_key:
        return {
            "api_url": settings.tokko_api_url,
            "api_key": settings.tokko_api_key
        }
    return None


async def sync_lead_to_tokko(lead: LeadInput, company_id: int) -> dict:
    """Sync lead to Tokko API"""
    creds = get_tokko_credentials(company_id)
    
    if not creds:
        return {"ok": False, "reason": "tokko_not_configured"}
    
    try:
        api_url = creds["api_url"].rstrip("/")
        api_key = creds["api_key"]
        
        url = f"{api_url}/webcontact/?key={api_key}"
        
        payload = {
            "name": lead.name or "Lead Charlott",
            "phone": lead.phone.replace("+", "").replace(" ", ""),
            "email": lead.email,
            "text": lead.message or "Nuevo lead desde Charlott CRM",
            "source": lead.source or "Charlott CRM",
            "tags": ["Lead_Calificado", "Bot"] if not lead.tags else lead.tags
        }
        
        response = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=30)
        
        if response.status_code in [200, 201]:
            try:
                data = response.json() if response.text else {}
            except:
                data = {}
            return {"ok": True, "external_id": data.get("id") or data.get("lead_id")}
        else:
            return {"ok": False, "reason": "api_error", "status": response.status_code, "error": response.text[:200]}
    except Exception as e:
        return {"ok": False, "reason": "exception", "error": str(e)}


@router.post("/leads")
async def create_lead(
    lead: LeadInput,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Create lead via integration API"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    row = db.execute(
        text('INSERT INTO contacts (name, number, email, "leadStatus", "companyId", "createdAt", "updatedAt") '
             'VALUES (:name, :phone, :email, :status, :company_id, NOW(), NOW()) RETURNING id'),
        {"name": lead.name, "phone": lead.phone.replace("+", ""), "email": lead.email, "status": "new", "company_id": company_id}
    ).mappings().first()
    db.commit()
    
    contact_id = row["id"]
    tokko_result = await sync_lead_to_tokko(lead, company_id)
    
    return {"ok": True, "contact_id": contact_id, "tokko": tokko_result}


@router.post("/messages")
async def send_outbound_message(
    msg: OutboundMessageInput,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Send outbound message via integration"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    wa_config = db.execute(
        text('SELECT * FROM "whatsappConfigs" WHERE "companyId" = :company_id AND status = :status LIMIT 1'),
        {"company_id": company_id, "status": "CONNECTED"}
    ).mappings().first()
    
    if not wa_config:
        return {"ok": False, "reason": "whatsapp_not_connected"}
    
    phone_id = wa_config.get("phoneId")
    access_token = wa_config.get("token")
    
    if not phone_id or not access_token:
        return {"ok": False, "reason": "whatsapp_not_configured"}
    
    url = f"https://graph.facebook.com/v21.0/{phone_id}/messages"
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    
    payload_data = {
        "messaging_product": "whatsapp",
        "to": msg.phone,
        "type": "text",
        "text": {"body": msg.body}
    }
    
    try:
        response = requests.post(url, json=payload_data, headers=headers, timeout=30)
        if response.status_code in [200, 201]:
            data = response.json()
            return {"ok": True, "message_id": data.get("messages", [{}])[0].get("id")}
        else:
            return {"ok": False, "reason": "api_error", "error": response.text}
    except Exception as e:
        return {"ok": False, "reason": "exception", "error": str(e)}


@router.get("/messages/hardening-status")
async def get_hardening_status(payload: dict = Depends(get_current_user_payload)):
    """Get integration hardening metrics"""
    return {"ok": True, "metrics": {"outbound_total": 0, "outbound_success": 0, "outbound_failed": 0}}


@router.get("/tokko/status")
async def tokko_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Get Tokko integration status"""
    company_id = int(payload.get("companyId", 0))
    if not company_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="No company in token")
    creds = get_tokko_credentials(company_id, db=db)
    return {"ok": True, "connected": creds is not None}


@router.post("/tokko/properties/search")
async def tokko_search_properties(
    search: PropertySearchInput,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Search properties in Tokko API"""
    import httpx

    company_id = int(payload.get("companyId", 0))
    if not company_id:
        raise HTTPException(status_code=403, detail="No company in token")
    creds = get_tokko_credentials(company_id, db=db)
    
    if not creds:
        raise HTTPException(status_code=400, detail="Tokko not configured")
    
    params = {"key": creds["api_key"], "limit": search.limit, "operations": "sale"}
    
    if search.location:
        params["location"] = search.location
    if search.price_min:
        params["price_min"] = search.price_min
    if search.price_max:
        params["price_max"] = search.price_max
    if search.property_type:
        params["property_type"] = search.property_type
    if search.rooms:
        params["rooms_min"] = search.rooms
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{creds['api_url']}/properties", params=params, timeout=30.0)
            
            if resp.status_code == 200:
                data = resp.json()
                properties = []
                for prop in data.get("objects", [])[:search.limit]:
                    properties.append({
                        "id": prop.get("id"),
                        "title": prop.get("title", ""),
                        "location": prop.get("location", ""),
                        "address": prop.get("address", ""),
                        "price": prop.get("price", 0),
                        "currency": prop.get("currency", "USD"),
                        "type": prop.get("type", ""),
                        "rooms": prop.get("rooms", 0),
                        "bathrooms": prop.get("bathrooms", 0),
                        "total_area": prop.get("total_area", 0),
                        "description": prop.get("description", "")[:200],
                        "url": prop.get("url", "")
                    })
                return {"ok": True, "count": len(properties), "properties": properties}
            else:
                return {"ok": False, "error": f"Tokko API error: {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/tokko/properties/{property_id}/photos")
async def tokko_get_property_photos(
    property_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db)
):
    """Get photos for a property from Tokko"""
    import httpx

    company_id = int(payload.get("companyId", 0))
    if not company_id:
        raise HTTPException(status_code=403, detail="No company in token")
    creds = get_tokko_credentials(company_id, db=db)
    
    if not creds:
        raise HTTPException(status_code=400, detail="Tokko not configured")
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{creds['api_url']}/properties/{property_id}", params={"key": creds["api_key"]}, timeout=30.0)
            
            if resp.status_code == 200:
                data = resp.json()
                photos = []
                for i, photo in enumerate(data.get("images", [])[:5]):
                    photos.append({"index": i + 1, "url": photo.get("image", "")})
                return {"ok": True, "photos": photos}
            else:
                return {"ok": False, "error": f"Tokko API error: {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/")
async def list_integrations(payload: dict = Depends(get_current_user_payload)):
    """List all integrations"""
    return {"tokko": {"connected": False}, "meta": {"connected": False}, "whatsapp": {"connected": True}}


# ── Google Calendar (sincronización en dos vías) ──────────────────────

@router.get("/google/status")
def google_calendar_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    from app.services import google_calendar as gc
    company_id = int(payload.get("companyId") or 0)
    rows = db.execute(
        text("""SELECT id, user_id, email, calendar_id, last_sync_at, last_error,
                       (sync_token <> '') AS sincronizando
                FROM calendar_connections WHERE company_id = :c AND provider = 'google' ORDER BY id"""),
        {"c": company_id},
    ).mappings().all()
    return {
        "ok": True,
        "configurado": gc.is_configured(),
        "conexiones": [dict(r) for r in rows],
    }


@router.get("/google/auth-url")
def google_calendar_auth_url(
    solo_mio: bool = False,
    payload: dict = Depends(get_current_user_payload),
):
    """URL del consentimiento de Google. `solo_mio` conecta el calendario del
    usuario que la pide; por defecto se conecta el de la empresa."""
    from jose import jwt as _jwt
    from app.services import google_calendar as gc
    if not gc.is_configured():
        raise HTTPException(status_code=503, detail="Falta configurar GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET")
    company_id = int(payload.get("companyId") or 0)
    # el state va firmado: el callback de Google llega sin sesión y sin esto
    # cualquiera podría colgar un calendario en la empresa que quisiera
    state = _jwt.encode(
        {"cid": company_id, "uid": int(payload.get("sub") or 0) if solo_mio else None, "k": "gcal"},
        settings.jwt_secret, algorithm="HS256")
    return {"ok": True, "url": gc.auth_url(state)}


@router.get("/google/callback")
def google_calendar_callback(
    code: str = "",
    state: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    """Vuelta del consentimiento. Endpoint público: la identidad viaja firmada
    en el state, no en la sesión."""
    from jose import jwt as _jwt
    from fastapi.responses import HTMLResponse
    from app.services import google_calendar as gc

    def _pagina(titulo: str, detalle: str) -> HTMLResponse:
        return HTMLResponse(
            "<html><head><meta charset='utf-8'><title>%s</title></head>"
            "<body style='background:#0C0E12;color:#E8E6E1;font-family:system-ui;padding:48px;text-align:center'>"
            "<h2 style='color:#E8A020'>%s</h2><p>%s</p>"
            "<p style='opacity:.6'>Ya podés cerrar esta pestaña.</p></body></html>" % (titulo, titulo, detalle))

    if error or not code:
        return _pagina("No se pudo conectar", error or "Google no devolvió el código de autorización.")
    try:
        data = _jwt.decode(state, settings.jwt_secret, algorithms=["HS256"])
        if data.get("k") != "gcal":
            raise ValueError("state inválido")
    except Exception:
        return _pagina("No se pudo conectar", "El pedido no es válido o venció. Probá de nuevo desde el CRM.")

    try:
        tokens = gc.exchange_code(code)
        res = gc.save_connection(db, int(data["cid"]), data.get("uid"), tokens)
    except Exception as e:
        return _pagina("No se pudo conectar", str(e)[:200])
    return _pagina("Calendario conectado", "Google Calendar quedó sincronizado con la agenda del CRM (%s)."
                   % (res.get("email") or "cuenta conectada"))


@router.post("/google/sync")
def google_calendar_sync_now(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    from app.services import google_calendar as gc
    company_id = int(payload.get("companyId") or 0)
    conns = db.execute(
        text("SELECT * FROM calendar_connections WHERE company_id = :c AND provider = 'google'"),
        {"c": company_id},
    ).mappings().all()
    if not conns:
        raise HTTPException(status_code=400, detail="No hay ningún calendario conectado")
    return {"ok": True, "resultados": [gc.pull_changes(db, dict(c)) for c in conns]}


@router.delete("/google/{connection_id}")
def google_calendar_disconnect(
    connection_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = int(payload.get("companyId") or 0)
    db.execute(text("DELETE FROM calendar_connections WHERE id = :i AND company_id = :c"),
               {"i": connection_id, "c": company_id})
    db.commit()
    return {"ok": True}


# ── Carrusel nativo de WhatsApp (inmobiliarias) ───────────────────────

class CarouselCreateBody(BaseModel):
    sample_image_url: str = ""


@router.get("/carousel/status")
def carousel_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    from app.services import wa_carousel
    return wa_carousel.template_status(db, int(payload.get("companyId") or 0))


@router.post("/carousel/template")
def carousel_create(
    body: CarouselCreateBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Crea la plantilla de carrusel en el WABA de la empresa y la manda a
    revisión de Meta. Tarda: la aprobación no es inmediata."""
    import httpx as _httpx
    from app.services import wa_carousel

    company_id = int(payload.get("companyId") or 0)
    url = (body.sample_image_url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Falta la foto de ejemplo (sample_image_url)")
    try:
        r = _httpx.get(url, timeout=45, follow_redirects=True)
        if r.status_code != 200 or not r.content:
            raise HTTPException(status_code=400, detail="No se pudo descargar la foto de ejemplo")
        img = r.content
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail="No se pudo descargar la foto de ejemplo: %s" % str(e)[:120])

    res = wa_carousel.create_template(db, company_id, img)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Meta rechazó la plantilla")[:400])
    return res


# ── Pixel de Meta: avisar las ventas cerradas ─────────────────────────

class PixelBody(BaseModel):
    pixel_id: Optional[str] = None
    token: Optional[str] = None
    currency: Optional[str] = None
    enabled: Optional[bool] = None


@router.get("/pixel")
def pixel_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    from app.services import meta_pixel
    company_id = int(payload.get("companyId") or 0)
    cfg = meta_pixel.get_config(db, company_id)
    return {**cfg, "verificacion": meta_pixel.check_pixel(db, company_id) if cfg["pixel_id"] else None}


@router.get("/pixel/disponibles")
def pixel_list(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Pixeles que ve el token de la empresa. Se muestran con el nombre de la
    cuenta publicitaria porque la eleccion la tiene que confirmar una persona:
    el token no alcanza para saber de quien es el pixel."""
    from app.services import meta_pixel
    return meta_pixel.list_pixels(db, int(payload.get("companyId") or 0))


@router.put("/pixel")
def pixel_save(
    body: PixelBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    from app.services import meta_pixel
    company_id = int(payload.get("companyId") or 0)
    cfg = meta_pixel.save_config(db, company_id, body.pixel_id, body.token, body.currency, body.enabled)
    return {**cfg, "verificacion": meta_pixel.check_pixel(db, company_id) if cfg["pixel_id"] else None}


class PixelTestBody(BaseModel):
    test_event_code: str
    contact_id: Optional[int] = None


@router.post("/pixel/probar")
def pixel_test(
    body: PixelTestBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Manda un evento de prueba al pixel. Con el codigo de Events Manager el
    evento aparece en "Eventos de prueba" y Meta no lo usa para optimizar, asi
    que sirve para confirmar la conexion sin ensuciar la cuenta."""
    from app.services import meta_pixel
    company_id = int(payload.get("companyId") or 0)
    codigo = (body.test_event_code or "").strip()
    if not codigo:
        raise HTTPException(status_code=400, detail="Falta el código de prueba de Events Manager")

    contact_id = body.contact_id or db.execute(
        text('SELECT id FROM contacts WHERE "companyId" = :c ORDER BY id DESC LIMIT 1'),
        {"c": company_id},
    ).scalar()
    if not contact_id:
        raise HTTPException(status_code=400, detail="La empresa todavía no tiene ningún contacto")

    res = meta_pixel.send_conversion(db, company_id, int(contact_id), value=1,
                                     test_event_code=codigo)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("detail") or res.get("status"))
    return res


class PixelOAuthBody(BaseModel):
    access_token: Optional[str] = None
    code: Optional[str] = None


@router.post("/pixel/oauth")
async def pixel_oauth(
    body: PixelOAuthBody,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """El cliente autoriza su cuenta publicitaria desde el CRM.

    Sin esto, el unico token disponible es el del proveedor, que no ve los
    activos del cliente: ni el pixel ni la campaña de la que vino cada lead.
    """
    require_admin(payload)
    from app.api.v1.endpoints.channels_routes import _extend_user_token, _exchange_meta_code
    from app.services import meta_pixel

    company_id = int(payload.get("companyId") or 0)
    if (body.access_token or "").strip():
        token = await _extend_user_token(body.access_token.strip())
    elif (body.code or "").strip():
        token = await _exchange_meta_code(body.code.strip())
    else:
        raise HTTPException(status_code=400, detail="Meta no devolvió la autorización")

    meta_pixel.guardar_token_ads(db, company_id, token)
    encontrados = meta_pixel.list_pixels(db, company_id)
    return {"ok": True, "pixeles": encontrados.get("pixeles") or [],
            "detail": encontrados.get("detail") or ""}
