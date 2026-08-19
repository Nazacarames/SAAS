"""Primer contacto automatico al lead que deja un formulario de Meta.

El lead de formulario nunca escribio: no hay ventana de 24 h abierta, asi que
el primer mensaje TIENE que ser una plantilla aprobada. La plantilla lleva dos
variables, el nombre y lo que pidio en el formulario, para que el mensaje no
sea generico y la persona reconozca de que se trata.

Config por empresa en ai_agents.ai_config_json:
  "contacto_formulario": {
    "enabled": true,
    "template_name": "contacto_formulario",
    "template_lang": "es_AR"
  }
"""

import json
import logging
import re
import unicodedata

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.form_followup")

GRAPH = "https://graph.facebook.com/v21.0"
TEMPLATE_POR_DEFECTO = "contacto_formulario"
IDIOMA_POR_DEFECTO = "es_AR"

# El cuerpo se manda a aprobar tal cual. {{1}} = nombre, {{2}} = lo que pidio.
CUERPO = ("Hola {{1}}! Gracias por dejarnos tus datos. Vimos que consultaste por {{2}}. "
          "Un asesor te va a contactar a la brevedad. Si querés, respondé este mensaje "
          "y seguimos por acá.")


def _cfg(db: Session, company_id: int) -> dict:
    raw = db.execute(
        text("SELECT ai_config_json FROM ai_agents WHERE company_id = :c AND is_active = true "
             "ORDER BY id DESC LIMIT 1"),
        {"c": company_id},
    ).scalar()
    try:
        return (json.loads(raw or "{}") or {}).get("contacto_formulario") or {}
    except Exception:
        return {}


def _waba_de(db: Session, company_id: int) -> str:
    fila = db.execute(
        text("SELECT config_json FROM channels WHERE company_id = :c AND channel_type = 'whatsapp' "
             "AND status = 'active' ORDER BY id DESC LIMIT 1"),
        {"c": company_id},
    ).scalar()
    try:
        cfg = json.loads(fila) if isinstance(fila, str) else (fila or {})
    except Exception:
        cfg = {}
    return str(cfg.get("wabaId") or "")


def _legible(valor: str) -> str:
    """Las respuestas de Meta vienen como amoblamientos_de_cocina."""
    v = re.sub(r"_+", " ", str(valor or "")).strip()
    return (v[:1].upper() + v[1:]) if v else ""


def que_pidio(campos: dict) -> str:
    """Lo que el lead eligio en el formulario, en una frase corta.

    Se prefiere la pregunta que describe el interes (proyecto, servicio,
    producto) sobre el resto; si no hay ninguna reconocible, se usa la primera
    respuesta que no sea un dato de contacto.
    """
    def norm(s):
        return unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()

    preferidas = ("proyecto", "servicio", "producto", "interes", "buscas", "necesita",
                  "consulta", "rubro", "opcion")
    contacto = ("nombre", "name", "mail", "correo", "telefono", "phone", "celular")
    for clave in preferidas:
        for k, v in campos.items():
            if clave in norm(k) and v:
                return _legible(v)
    for k, v in campos.items():
        if v and not any(c in norm(k) for c in contacto):
            return _legible(v)
    return "tu consulta"


def crear_plantilla(db: Session, company_id: int, nombre: str = TEMPLATE_POR_DEFECTO,
                    idioma: str = IDIOMA_POR_DEFECTO) -> dict:
    """Manda la plantilla a revision de Meta. La aprobacion no es inmediata."""
    from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config
    wa = get_whatsapp_config(db, company_id)
    waba = _waba_de(db, company_id)
    if not (wa and waba):
        return {"ok": False, "error": "La empresa no tiene WhatsApp conectado"}
    r = httpx.post(
        "%s/%s/message_templates" % (GRAPH, waba),
        headers={"Authorization": "Bearer %s" % wa["token"]},
        json={
            "name": nombre,
            "language": idioma,
            "category": "UTILITY",
            "components": [{
                "type": "BODY",
                "text": CUERPO,
                "example": {"body_text": [["Sebastian", "amoblamientos de cocina"]]},
            }],
        },
        timeout=40,
    )
    datos = r.json()
    if r.status_code != 200 or datos.get("error"):
        return {"ok": False, "error": json.dumps(datos.get("error") or datos)[:300]}
    return {"ok": True, "id": datos.get("id"), "status": datos.get("status")}


def estado_plantilla(db: Session, company_id: int, nombre: str = TEMPLATE_POR_DEFECTO) -> str:
    """APPROVED | PENDING | REJECTED | missing"""
    from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config
    wa = get_whatsapp_config(db, company_id)
    waba = _waba_de(db, company_id)
    if not (wa and waba):
        return "missing"
    try:
        r = httpx.get("%s/%s/message_templates" % (GRAPH, waba),
                      params={"access_token": wa["token"], "fields": "name,status", "limit": 200},
                      timeout=25).json()
        for t in (r.get("data") or []):
            if t.get("name") == nombre:
                return str(t.get("status") or "missing")
    except Exception:
        pass
    return "missing"


async def contactar(db: Session, company_id: int, contact_id: int,
                    nombre: str, telefono: str, campos: dict) -> dict:
    """Primer mensaje al lead de formulario. Best effort: si falla, el lead ya
    quedo cargado igual y el asesor lo ve en el CRM."""
    cfg = _cfg(db, company_id)
    if not cfg.get("enabled") or not telefono:
        return {"ok": False, "reason": "desactivado"}

    from app.api.v1.endpoints.webhook_whatsapp import get_whatsapp_config, save_message
    from app.services.whatsapp_service import send_whatsapp_template
    wa = get_whatsapp_config(db, company_id)
    if not wa:
        return {"ok": False, "reason": "sin_whatsapp"}

    plantilla = str(cfg.get("template_name") or TEMPLATE_POR_DEFECTO)
    idioma = str(cfg.get("template_lang") or IDIOMA_POR_DEFECTO)
    primer_nombre = str(nombre or "").strip().split(" ")[0] or "Hola"
    interes = que_pidio(campos)

    res = await send_whatsapp_template(
        phone=re.sub(r"\D", "", telefono),
        template_name=plantilla,
        components=[{"type": "body", "parameters": [
            {"type": "text", "text": primer_nombre[:60]},
            {"type": "text", "text": interes[:60]},
        ]}],
        whatsapp_phone_id=wa.get("phoneId"),
        access_token=wa.get("token"),
    )
    if not res.get("ok"):
        log.info("form followup: no se pudo contactar al lead %s (%s)", contact_id, str(res)[:140])
        return {"ok": False, "reason": "envio_fallido", "detalle": str(res)[:200]}

    cuerpo = CUERPO.replace("{{1}}", primer_nombre).replace("{{2}}", interes)
    try:
        save_message(db, contact_id, cuerpo, True, company_id)
    except Exception:
        db.rollback()
    log.info("form followup: contactado el lead %s (%s)", contact_id, interes)
    return {"ok": True, "interes": interes}
