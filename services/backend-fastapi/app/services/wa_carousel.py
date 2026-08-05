"""Carrusel nativo de WhatsApp para mostrar propiedades.

Hoy las fichas se mandan como una foto + texto por propiedad: ocupa media
pantalla y el cliente tiene que scrollear. El carrusel las deja en tarjetas que
se pasan de costado, con botón propio en cada una.

Lo que hay que saber antes de tocar esto:

- El carrusel SOLO existe como plantilla. No se puede armar al vuelo como un
  mensaje libre, ni siquiera dentro de la ventana de 24 h.
- La plantilla la aprueba Meta y vive en el WABA del cliente, así que hay que
  crearla una vez por inmobiliaria y esperar la aprobación.
- Todas las tarjetas tienen que tener la MISMA estructura: si una lleva botón de
  link, todas lo llevan. Por eso se manda siempre el mismo formato de tarjeta.
- Máximo 10 tarjetas; se usan 5, que es lo que un cliente mira sin cansarse.

Si la plantilla no está aprobada, el envío cae solo al formato de fichas de
siempre: nadie se queda sin ver las propiedades por esperar a Meta.
"""
import json
import logging

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.carousel")

GRAPH = "https://graph.facebook.com/v21.0"
TEMPLATE_NAME = "propiedades_carrusel"
LANG = "es_AR"
MAX_CARDS = 5

# Una tarjeta: foto + 3 líneas + botón que abre la ficha.
_CARD = {
    "components": [
        {"type": "HEADER", "format": "IMAGE", "example": {"header_handle": ["__HANDLE__"]}},
        # Meta rechaza las plantillas con muchas variables y poco texto ("la
        # proporción entre parámetros y palabras supera el límite"), así que
        # cada línea lleva su etiqueta escrita en vez de una variable suelta.
        {"type": "BODY",
         # máximo 2 saltos de línea por tarjeta: con 3 Meta la rechaza
         "text": "{{1}}\nUbicación: {{2}}\nPrecio: {{3}}. Consultanos y coordinamos una visita.",
         "example": {"body_text": [["Casa 3 amb con patio", "Fisherton, Rosario", "USD 145.000"]]}},
        {"type": "BUTTONS", "buttons": [
            {"type": "URL", "text": "Ver ficha", "url": "https://ficha.info/p/{{1}}",
             "example": ["https://ficha.info/p/123"]},
        ]},
    ]
}


def _waba_and_token(db: Session, company_id: int) -> tuple[str, str]:
    row = db.execute(
        text("""SELECT c.config_json, c.external_id, mc.access_token FROM channels c
                LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
                WHERE c.company_id = :co AND c.channel_type = 'whatsapp' AND c.status = 'active'
                ORDER BY c.id LIMIT 1"""),
        {"co": company_id},
    ).mappings().first()
    if not row:
        return "", ""
    from app.services.crypto import decrypt
    cfg = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else (row["config_json"] or {})
    token = decrypt(row["access_token"]) if row["access_token"] else ""
    waba = str(cfg.get("wabaId") or "")
    if not waba and token:
        # Los canales conectados antes del wizard no cachearon el WABA: se
        # resuelve desde el número, que es el dato que sí tenemos siempre.
        try:
            from app.api.v1.endpoints.channels_routes import _resolve_waba_for_phone
            with httpx.Client(timeout=25) as c:
                waba = _resolve_waba_for_phone(c, str(row["external_id"] or ""), token)
        except Exception as e:
            log.warning("no se pudo resolver el WABA de company=%s: %s", company_id, str(e)[:120])
    return waba, token


def _upload_sample_image(app_id: str, token: str, image_bytes: bytes, mime: str = "image/jpeg") -> str:
    """Sube la foto de ejemplo que Meta pide para aprobar la plantilla y
    devuelve el handle. Es la Resumable Upload API, en dos pasos."""
    with httpx.Client(timeout=60) as c:
        r = c.post("%s/%s/uploads" % (GRAPH, app_id),
                   params={"file_length": len(image_bytes), "file_type": mime, "access_token": token})
        if r.status_code != 200:
            raise RuntimeError("no se pudo iniciar la subida: %s" % r.text[:200])
        session = r.json().get("id", "")
        r2 = c.post("%s/%s" % (GRAPH, session),
                    headers={"Authorization": "OAuth %s" % token, "file_offset": "0"},
                    content=image_bytes)
        if r2.status_code != 200:
            raise RuntimeError("no se pudo subir la imagen: %s" % r2.text[:200])
        return r2.json().get("h", "")


def create_template(db: Session, company_id: int, sample_image: bytes) -> dict:
    """Crea la plantilla de carrusel en el WABA de la inmobiliaria."""
    import os
    waba, token = _waba_and_token(db, company_id)
    if not waba or not token:
        return {"ok": False, "error": "La empresa no tiene un canal de WhatsApp activo con WABA"}
    app_id = os.getenv("META_APP_ID", "").strip()
    try:
        handle = _upload_sample_image(app_id, token, sample_image)
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
    if not handle:
        return {"ok": False, "error": "Meta no devolvió el identificador de la imagen de ejemplo"}

    card = json.loads(json.dumps(_CARD).replace("__HANDLE__", handle))
    body = {
        "name": TEMPLATE_NAME,
        "language": LANG,
        "category": "MARKETING",
        "components": [
            {"type": "BODY", "text": "Te paso las opciones que mejor encajan con lo que estas buscando. "
                                     "Desliza para verlas y toca Ver ficha en la que te guste."},
            {"type": "CAROUSEL", "cards": [json.loads(json.dumps(card)) for _ in range(MAX_CARDS)]},
        ],
    }
    with httpx.Client(timeout=60) as c:
        r = c.post("%s/%s/message_templates" % (GRAPH, waba),
                   headers={"Authorization": "Bearer %s" % token}, json=body)
    if r.status_code not in (200, 201):
        return {"ok": False, "error": r.text[:400]}
    return {"ok": True, "id": r.json().get("id"), "status": r.json().get("status")}


def template_status(db: Session, company_id: int) -> dict:
    waba, token = _waba_and_token(db, company_id)
    if not waba or not token:
        return {"ok": False, "error": "sin canal de WhatsApp activo"}
    with httpx.Client(timeout=30) as c:
        r = c.get("%s/%s/message_templates" % (GRAPH, waba),
                  params={"name": TEMPLATE_NAME, "access_token": token})
    if r.status_code != 200:
        return {"ok": False, "error": r.text[:200]}
    data = (r.json().get("data") or [])
    if not data:
        return {"ok": True, "existe": False, "estado": "no creada"}
    t = data[0]
    return {"ok": True, "existe": True, "estado": t.get("status"), "categoria": t.get("category")}


def is_ready(db: Session, company_id: int) -> bool:
    try:
        st = template_status(db, company_id)
        return bool(st.get("existe") and str(st.get("estado")).upper() == "APPROVED")
    except Exception:
        return False


def _card_params(prop: dict, index: int) -> dict:
    titulo = str(prop.get("title") or "Propiedad")[:60]
    # "Argentina | Santa Fe | Rosario | Centro" no entra ni sirve en una
    # tarjeta: se deja lo ultimo, que es lo que identifica el barrio.
    _loc = str(prop.get("location") or "").replace(" | ", ",")
    _partes = [x.strip() for x in _loc.split(",") if x.strip()]
    zona = (", ".join(_partes[-2:]) if len(_partes) >= 2 else (_loc or "Consultar zona"))[:60]
    precio = str(prop.get("price") or "Consultar")[:60]
    foto = str(prop.get("photo") or "")
    # el botón lleva el sufijo de la URL de la ficha; si no hay, se manda el id
    url = str(prop.get("url") or "")
    sufijo = url.rstrip("/").split("/p/")[-1] if "/p/" in url else str(prop.get("id") or index)
    return {
        "card_index": index,
        "components": [
            {"type": "header", "parameters": [{"type": "image", "image": {"link": foto}}]},
            {"type": "body", "parameters": [
                {"type": "text", "text": titulo},
                {"type": "text", "text": zona},
                {"type": "text", "text": precio},
            ]},
            {"type": "button", "sub_type": "url", "index": "0",
             "parameters": [{"type": "text", "text": sufijo}]},
        ],
    }


def send_carousel(db: Session, company_id: int, to: str, properties: list[dict], wa_config: dict) -> dict:
    """Manda las propiedades como carrusel. Devuelve {'ok': bool, ...}."""
    usable = [p for p in properties if str(p.get("photo") or "").startswith("http")][:MAX_CARDS]
    if not usable:
        return {"ok": False, "error": "ninguna propiedad tiene foto (el carrusel la exige)"}

    payload = {
        "messaging_product": "whatsapp", "to": to, "type": "template",
        "template": {
            "name": TEMPLATE_NAME, "language": {"code": LANG},
            "components": [
                {"type": "carousel", "cards": [_card_params(p, i) for i, p in enumerate(usable)]},
            ],
        },
    }
    try:
        with httpx.Client(timeout=30) as c:
            r = c.post("%s/%s/messages" % (GRAPH, wa_config.get("phoneId")),
                       headers={"Authorization": "Bearer %s" % wa_config.get("token")}, json=payload)
        if r.status_code == 200:
            return {"ok": True, "enviadas": len(usable)}
        log.warning("carrusel company=%s: %s", company_id, r.text[:250])
        return {"ok": False, "error": r.text[:250]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
