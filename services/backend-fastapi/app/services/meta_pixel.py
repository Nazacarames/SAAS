"""Conversions API: avisarle al pixel de Meta cuando un lead se cierra con venta.

El pixel se elige a mano por empresa y se guarda en company_runtime_settings
(metaPixelId). NO se autodetecta: hoy varias empresas tienen guardado el MISMO
token de system user, asi que deducir el pixel desde el token mandaria las
ventas de un cliente al pixel de otro. La deteccion existe (list_pixels) pero
solo para ofrecer la lista; la eleccion la confirma una persona.

Cada cierre queda registrado en lead_conversions aunque el pixel no este
configurado: la tabla es el registro de ventas del CRM y el envio a Meta es un
campo mas de esa fila.
"""

import hashlib
import json
import os
import logging
import time

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.crypto import decrypt, encrypt

log = logging.getLogger("app.meta_pixel")

GRAPH = "https://graph.facebook.com/v21.0"


def _ensure_table(db: Session) -> None:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS lead_conversions (
            id BIGSERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            contact_id INTEGER,
            stage_id BIGINT,
            user_id INTEGER,
            value NUMERIC(14,2) NOT NULL DEFAULT 0,
            currency VARCHAR(8) NOT NULL DEFAULT 'ARS',
            event_name VARCHAR(40) NOT NULL DEFAULT 'Purchase',
            pixel_id VARCHAR(40),
            status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
            detail TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    db.execute(text(
        "CREATE INDEX IF NOT EXISTS lead_conversions_company_idx "
        "ON lead_conversions (company_id, created_at DESC)"
    ))
    db.commit()


# ── configuracion por empresa ─────────────────────────────────────
def _read_settings(db: Session, company_id: int) -> dict:
    raw = db.execute(
        text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :c"),
        {"c": company_id},
    ).scalar()
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        return {}


def save_config(db: Session, company_id: int, pixel_id: str | None,
                token: str | None, currency: str | None, enabled: bool | None) -> dict:
    cfg = _read_settings(db, company_id)
    if pixel_id is not None:
        cfg["metaPixelId"] = "".join(ch for ch in str(pixel_id) if ch.isdigit())
    if token:
        cfg["metaPixelToken"] = encrypt(token.strip())
    if currency:
        cfg["metaPixelCurrency"] = currency.strip().upper()[:8]
    if enabled is not None:
        cfg["metaPixelEnabled"] = bool(enabled)
    db.execute(
        text("INSERT INTO company_runtime_settings (company_id, settings_json, updated_at) "
             "VALUES (:c, :s, NOW()) ON CONFLICT (company_id) DO UPDATE "
             "SET settings_json = :s, updated_at = NOW()"),
        {"c": company_id, "s": json.dumps(cfg)},
    )
    db.commit()
    return get_config(db, company_id)


def get_config(db: Session, company_id: int) -> dict:
    cfg = _read_settings(db, company_id)
    return {
        "pixel_id": str(cfg.get("metaPixelId") or ""),
        "currency": str(cfg.get("metaPixelCurrency") or "ARS"),
        # el token propio es opcional: si no hay, se usa el de la conexion de Meta
        "token_propio": bool(cfg.get("metaPixelToken")),
        "enabled": bool(cfg.get("metaPixelEnabled", True)),
    }


def _token(db: Session, company_id: int) -> str:
    """Token para hablar con Graph: el cargado a mano, si no el de la conexion."""
    cfg = _read_settings(db, company_id)
    propio = decrypt(str(cfg.get("metaPixelToken") or ""))
    if propio:
        return propio
    row = db.execute(
        text("SELECT access_token FROM meta_connections WHERE company_id = :c "
             "AND access_token IS NOT NULL ORDER BY id DESC LIMIT 1"),
        {"c": company_id},
    ).scalar()
    return decrypt(row or "")


# ── deteccion de pixeles (solo para llenar el selector) ───────────
def _negocios_de(db: Session, company_id: int, cli: httpx.Client, token: str) -> dict:
    """Negocios (portfolios) dueños de los activos YA CONECTADOS de la empresa.

    Es el unico anclaje confiable: preguntarle al token que ve (/me/adaccounts)
    devuelve lo que ve su dueño, y hoy varias empresas comparten el mismo token
    de system user, asi que a un cliente le aparecian los pixeles de OTRO.
    """
    negocios: dict[str, str] = {}
    filas = db.execute(
        text("SELECT channel_type, external_id, config_json FROM channels "
             "WHERE company_id = :c AND status = 'active'"),
        {"c": company_id},
    ).mappings().all()
    for f in filas:
        try:
            cfg = json.loads(f["config_json"]) if isinstance(f["config_json"], str) else (f["config_json"] or {})
        except Exception:
            cfg = {}
        if f["channel_type"] == "whatsapp":
            waba = str(cfg.get("wabaId") or "")
            if not waba:
                # los canales viejos no guardaron el WABA: se resuelve desde el
                # numero, igual que hace el diagnostico de canales
                waba = str(db.execute(
                    text("SELECT waba_id FROM meta_connections WHERE company_id = :c "
                         "AND waba_id IS NOT NULL ORDER BY id DESC LIMIT 1"),
                    {"c": company_id},
                ).scalar() or "")
            if not waba:
                try:
                    from app.api.v1.endpoints.channels_routes import _resolve_waba_for_phone
                    waba = str(_resolve_waba_for_phone(cli, str(f["external_id"] or ""), token) or "")
                except Exception:
                    waba = ""
            if not waba:
                continue
            r = cli.get(f"{GRAPH}/{waba}", params={"access_token": token,
                                                   "fields": "owner_business_info"}).json()
            info = r.get("owner_business_info") or {}
            if info.get("id"):
                negocios[str(info["id"])] = str(info.get("name") or info["id"])
        else:
            page = str(f["external_id"] or "")
            if not page:
                continue
            r = cli.get(f"{GRAPH}/{page}", params={"access_token": token,
                                                   "fields": "business"}).json()
            biz = r.get("business") or {}
            if biz.get("id"):
                negocios[str(biz["id"])] = str(biz.get("name") or biz["id"])
    return negocios


def list_pixels(db: Session, company_id: int) -> dict:
    """Pixeles del portfolio de ESTA empresa, sacados de sus propios activos."""
    token = _token(db, company_id)
    if not token:
        return {"ok": False, "pixeles": [], "detail": "La empresa no tiene ninguna conexion de Meta"}
    try:
        with httpx.Client(timeout=30) as cli:
            negocios = _negocios_de(db, company_id, cli, token)
            if not negocios:
                return {"ok": False, "pixeles": [],
                        "detail": "No se pudo identificar el portfolio de esta empresa. "
                                  "Conectá primero un canal (WhatsApp, Instagram o Messenger) "
                                  "o cargá el ID del píxel a mano."}
            pixeles = []
            for biz_id, biz_nombre in negocios.items():
                for edge in ("owned_pixels", "client_pixels"):
                    r = cli.get(f"{GRAPH}/{biz_id}/{edge}",
                                params={"access_token": token,
                                        "fields": "id,name,last_fired_time", "limit": 50}).json()
                    for p in (r.get("data") or []):
                        pixeles.append({
                            "id": p["id"],
                            "name": p.get("name") or p["id"],
                            "cuenta": biz_nombre,
                            "last_fired_time": p.get("last_fired_time"),
                        })
        if not pixeles:
            # Caso tipico: el canal se conecto por el camino de respaldo y quedo
            # guardado el token del proveedor, que no tiene permiso sobre los
            # activos del cliente aunque el cliente los haya compartido.
            if token == os.getenv("META_SYSTEM_TOKEN", "").strip():
                return {"ok": True, "pixeles": [],
                        "detail": "Esta empresa quedó conectada con el token del proveedor, que no "
                                  "tiene permiso sobre los píxeles de %s aunque te los hayan "
                                  "compartido. Cargá el ID del píxel a mano y, en «Token propio», "
                                  "uno generado en el Business Manager del cliente."
                                  % ", ".join(negocios.values())}
            return {"ok": True, "pixeles": [],
                    "detail": "El portfolio de %s no tiene ningún píxel visible. Si existe, "
                              "cargá el ID a mano o un token con permiso sobre esa cuenta."
                              % ", ".join(negocios.values())}
        return {"ok": True, "pixeles": pixeles}
    except Exception as e:
        log.warning("pixel: no se pudieron listar (%s)", e)
        return {"ok": False, "pixeles": [], "detail": str(e)[:200]}


def check_pixel(db: Session, company_id: int) -> dict:
    """Confirma que el pixel configurado existe y que el token puede escribirle."""
    cfg = get_config(db, company_id)
    if not cfg["pixel_id"]:
        return {"ok": False, "detail": "Falta elegir el pixel"}
    token = _token(db, company_id)
    if not token:
        return {"ok": False, "detail": "No hay token de Meta para esta empresa"}
    try:
        r = httpx.get(f"{GRAPH}/{cfg['pixel_id']}",
                      params={"access_token": token, "fields": "id,name,last_fired_time"},
                      timeout=30).json()
    except Exception as e:
        return {"ok": False, "detail": str(e)[:200]}
    if r.get("error"):
        return {"ok": False, "detail": r["error"].get("message", "")[:200]}
    return {"ok": True, "id": r.get("id"), "name": r.get("name"),
            "last_fired_time": r.get("last_fired_time")}


# ── envio del evento ──────────────────────────────────────────────
def _sha(v: str) -> str:
    return hashlib.sha256(v.encode("utf-8")).hexdigest()


def _user_data(contact: dict) -> dict:
    """Datos de contacto hasheados: es como Meta reconoce a la persona que ya
    habia clickeado el aviso. Sin ninguno de estos, el evento entra pero no se
    atribuye a nadie."""
    ud: dict = {}
    numero = "".join(ch for ch in str(contact.get("number") or "") if ch.isdigit())
    if numero:
        ud["ph"] = [_sha(numero)]
    email = str(contact.get("email") or "").strip().lower()
    if email:
        ud["em"] = [_sha(email)]
    partes = str(contact.get("name") or "").strip().lower().split()
    if partes:
        ud["fn"] = [_sha(partes[0])]
        if len(partes) > 1:
            ud["ln"] = [_sha(partes[-1])]
    return ud


def send_conversion(db: Session, company_id: int, contact_id: int, *,
                    stage_id: int | None = None, user_id: int | None = None,
                    value: float = 0.0, currency: str | None = None,
                    event_name: str = "Purchase", test_event_code: str = "") -> dict:
    """Registra la venta y, si hay pixel configurado, la manda por Conversions API.

    Nunca levanta excepcion: mover un lead a Cierre no puede fallar porque Meta
    no conteste.
    """
    _ensure_table(db)
    cfg = get_config(db, company_id)
    moneda = (currency or cfg["currency"] or "ARS").upper()[:8]

    contact = db.execute(
        text('SELECT id, name, number, email, channel_id FROM contacts '
             'WHERE id = :i AND "companyId" = :c'),
        {"i": contact_id, "c": company_id},
    ).mappings().first()
    if not contact:
        return {"ok": False, "status": "sin_contacto"}

    conv_id = db.execute(
        text("INSERT INTO lead_conversions "
             "(company_id, contact_id, stage_id, user_id, value, currency, event_name, pixel_id, status) "
             "VALUES (:c, :ct, :st, :u, :v, :cur, :ev, :px, 'pendiente') RETURNING id"),
        {"c": company_id, "ct": contact_id, "st": stage_id, "u": user_id,
         "v": value or 0, "cur": moneda, "ev": event_name, "px": cfg["pixel_id"] or None},
    ).scalar()
    db.commit()

    if not cfg["enabled"] or not cfg["pixel_id"]:
        db.execute(text("UPDATE lead_conversions SET status = 'sin_pixel', "
                        "detail = 'La empresa no tiene pixel configurado' WHERE id = :i"),
                   {"i": conv_id})
        db.commit()
        return {"ok": False, "status": "sin_pixel", "conversion_id": conv_id}

    token = _token(db, company_id)
    if not token:
        db.execute(text("UPDATE lead_conversions SET status = 'error', "
                        "detail = 'No hay token de Meta' WHERE id = :i"), {"i": conv_id})
        db.commit()
        return {"ok": False, "status": "error", "conversion_id": conv_id}

    evento = {
        "event_name": event_name,
        "event_time": int(time.time()),
        # el cierre se hace charlando, no en una web: "chat" es el origen que
        # Meta acepta con telefono/mail hasheados y sin datos del navegador
        "action_source": "chat",
        # event_id fijo por conversion: si el envio se reintenta, Meta lo
        # deduplica en vez de contar la venta dos veces
        "event_id": f"crm-{company_id}-{conv_id}",
        "user_data": _user_data(dict(contact)),
        "custom_data": {"value": float(value or 0), "currency": moneda,
                        "content_name": "Lead cerrado en CRM"},
    }
    cuerpo = {"access_token": token, "data": json.dumps([evento])}
    if test_event_code:
        # Con este codigo el evento cae en la pestaña "Eventos de prueba" de
        # Events Manager y Meta no lo usa para optimizar ni atribuir.
        cuerpo["test_event_code"] = test_event_code
    try:
        r = httpx.post(f"{GRAPH}/{cfg['pixel_id']}/events", data=cuerpo, timeout=20)
        body = r.json()
    except Exception as e:
        db.execute(text("UPDATE lead_conversions SET status = 'error', detail = :d WHERE id = :i"),
                   {"d": str(e)[:400], "i": conv_id})
        db.commit()
        log.warning("pixel: fallo el envio (%s)", e)
        return {"ok": False, "status": "error", "conversion_id": conv_id, "detail": str(e)[:200]}

    if body.get("error"):
        detalle = body["error"].get("message", "")[:400]
        db.execute(text("UPDATE lead_conversions SET status = 'error', detail = :d WHERE id = :i"),
                   {"d": detalle, "i": conv_id})
        db.commit()
        log.warning("pixel: Meta rechazo el evento (%s)", detalle)
        return {"ok": False, "status": "error", "conversion_id": conv_id, "detail": detalle}

    # Una prueba no es una venta: se registra el envio pero no se deja la fila
    # inflando el facturado del panel.
    if test_event_code:
        db.execute(text("DELETE FROM lead_conversions WHERE id = :i"), {"i": conv_id})
        db.commit()
        return {"ok": True, "status": "prueba", "pixel_id": cfg["pixel_id"],
                "respuesta": body}

    db.execute(text("UPDATE lead_conversions SET status = 'enviado', detail = :d WHERE id = :i"),
               {"d": json.dumps(body)[:400], "i": conv_id})
    db.commit()
    return {"ok": True, "status": "enviado", "conversion_id": conv_id,
            "pixel_id": cfg["pixel_id"], "value": float(value or 0), "currency": moneda}


# ── numeros para el panel ─────────────────────────────────────────
def stats(db: Session, company_id: int, dias: int = 30) -> dict:
    _ensure_table(db)
    row = db.execute(
        text("SELECT COUNT(*) AS ventas, COALESCE(SUM(value), 0) AS monto, "
             "COUNT(*) FILTER (WHERE status = 'enviado') AS enviadas, "
             "COUNT(*) FILTER (WHERE status = 'error') AS con_error, "
             "COUNT(*) FILTER (WHERE status = 'sin_pixel') AS sin_pixel "
             "FROM lead_conversions WHERE company_id = :c "
             "AND created_at >= NOW() - (:d || ' days')::interval"),
        {"c": company_id, "d": str(dias)},
    ).mappings().first()

    moneda = db.execute(
        text("SELECT currency FROM lead_conversions WHERE company_id = :c "
             "ORDER BY created_at DESC LIMIT 1"),
        {"c": company_id},
    ).scalar() or get_config(db, company_id)["currency"]

    ultimas = db.execute(
        text("SELECT lc.id, lc.value, lc.currency, lc.status, lc.detail, lc.created_at, "
             "c.name AS contacto FROM lead_conversions lc "
             'LEFT JOIN contacts c ON c.id = lc.contact_id '
             "WHERE lc.company_id = :c ORDER BY lc.created_at DESC LIMIT 8"),
        {"c": company_id},
    ).mappings().all()

    return {
        "dias": dias,
        "ventas": int(row["ventas"] or 0),
        "monto": float(row["monto"] or 0),
        "moneda": moneda,
        "enviadas": int(row["enviadas"] or 0),
        "con_error": int(row["con_error"] or 0),
        "sin_pixel": int(row["sin_pixel"] or 0),
        "pixel": get_config(db, company_id),
        "ultimas": [{
            "id": u["id"],
            "contacto": u["contacto"] or "Sin nombre",
            "value": float(u["value"] or 0),
            "currency": u["currency"],
            "status": u["status"],
            "detail": (u["detail"] or "")[:160] if u["status"] == "error" else None,
            "created_at": u["created_at"].isoformat() if u["created_at"] else None,
        } for u in ultimas],
    }
