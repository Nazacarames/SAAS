"""Leads de formulario de Meta (Lead Ads).

Meta avisa por webhook con un `leadgen_id`; los datos del formulario hay que ir
a buscarlos a Graph con el token de la PAGINA dueña del formulario. El aviso
llega una sola vez, asi que si falla la lectura el lead se pierde: por eso el
guard de duplicados se inserta despues de leer, no antes.

Esta funcion es la unica que ingesta: la usan el webhook unificado y el
endpoint por-empresa viejo.
"""

import json
import logging
import re
import unicodedata

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.crypto import decrypt

log = logging.getLogger("app.lead_ads")

GRAPH = "https://graph.facebook.com/v21.0"


def _page_token(db: Session, company_id: int, page_id: str) -> str:
    """Token de la pagina. Los tokens estan cifrados en la base: usarlos crudos
    daba "Cannot parse access token" y el lead se perdia."""
    fila = db.execute(
        text("SELECT access_token FROM meta_connections WHERE company_id = :c AND page_id = :p "
             "AND access_token IS NOT NULL ORDER BY id DESC LIMIT 1"),
        {"c": company_id, "p": page_id},
    ).scalar()
    if not fila:
        fila = db.execute(
            text("SELECT access_token FROM meta_connections WHERE company_id = :c "
                 "AND access_token IS NOT NULL ORDER BY id DESC LIMIT 1"),
            {"c": company_id},
        ).scalar()
    return decrypt(fila or "")


def _sin_acentos(s: str) -> str:
    return unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()


def _campo(campos: dict, *claves: str) -> str:
    """Busca por PEDAZO de nombre, no por nombre exacto.

    Cada cliente arma su formulario con las etiquetas que quiere y Meta las
    manda tal cual: "numero_de_telefono", "correo_electronico", "tu_celular".
    Con una lista de nombres exactos en ingles no coincidia ninguno y el lead
    entraba sin telefono ni mail, o sea invisible en el CRM.
    """
    for clave in claves:
        for nombre, valor in campos.items():
            if valor and clave in _sin_acentos(nombre):
                return str(valor).strip()
    return ""


def _parece_email(v: str) -> bool:
    return "@" in v and "." in v.split("@")[-1]


def _parece_telefono(v: str) -> bool:
    digitos = re.sub(r"\D", "", v)
    return len(digitos) >= 8 and len(digitos) <= 15 and len(digitos) >= len(v) - 5


def _nombre_form(db: Session, company_id: int, page_id: str, form_id: str) -> str:
    """Nombre del formulario. Es lo mas parecido a la campaña que se puede leer
    con el token de la pagina cuando la cuenta publicitaria no esta compartida."""
    if not form_id:
        return ""
    try:
        r = httpx.get(f"{GRAPH}/{form_id}", params={
            "access_token": _page_token(db, company_id, page_id), "fields": "name"}, timeout=15).json()
        nombre = str(r.get("name") or "")
        return "" if nombre.lower().startswith("formulario sin") else nombre[:120]
    except Exception:
        return ""


def ingest(db: Session, company_id: int, page_id: str, leadgen_id: str) -> dict:
    """Trae el lead de Graph, lo guarda y lo deja como contacto en el CRM."""
    from app.api.v1.endpoints._ai_shared import _ensure_meta_lead_tables
    from app.services import ad_attribution

    _ensure_meta_lead_tables(db)
    leadgen_id = str(leadgen_id or "").strip()
    if not leadgen_id:
        return {"ok": False, "reason": "sin_leadgen_id"}

    ya = db.execute(
        text("SELECT 1 FROM meta_lead_events WHERE company_id = :c AND leadgen_id = :l LIMIT 1"),
        {"c": company_id, "l": leadgen_id},
    ).scalar()
    if ya:
        return {"ok": True, "ingested": False, "reason": "duplicado"}

    token = _page_token(db, company_id, page_id)
    if not token:
        log.warning("lead ads: la empresa %s no tiene token para la pagina %s", company_id, page_id)
        return {"ok": False, "reason": "sin_token"}

    try:
        r = httpx.get(f"{GRAPH}/{leadgen_id}", params={
            "access_token": token,
            # is_organic/platform: Meta NO devuelve ad_id sin permiso sobre la
            # cuenta publicitaria, pero si dice si el lead vino de un aviso pago
            # y de que red. Es lo unico atribuible con el token de la pagina.
            "fields": ("field_data,form_id,ad_id,adset_id,campaign_id,created_time,"
                       "is_organic,platform"),
        }, timeout=20)
        datos = r.json()
    except Exception as e:
        log.error("lead ads: no se pudo leer %s (%s)", leadgen_id, str(e)[:120])
        return {"ok": False, "reason": "graph_error"}
    if datos.get("error") or not datos.get("field_data"):
        log.error("lead ads: Graph no devolvio el lead %s (%s)", leadgen_id,
                  json.dumps(datos.get("error") or {})[:160])
        return {"ok": False, "reason": "graph_sin_datos"}

    campos = {}
    for f in datos.get("field_data", []):
        nombre = str(f.get("name", "")).lower().strip()
        vals = f.get("values") or []
        if nombre and vals:
            campos[nombre] = vals[0]

    telefono = _campo(campos, "telefono", "phone", "celular", "movil", "whatsapp", "contacto")
    email = _campo(campos, "email", "mail", "correo")
    nombre = _campo(campos, "nombre", "name") or \
        ("%s %s" % (campos.get("first_name", ""), campos.get("last_name", ""))).strip()

    # Ultimo recurso: si el cliente puso etiquetas que no se parecen a nada, se
    # reconoce el dato por su forma. Un lead sin telefono ni mail no sirve.
    for valor in campos.values():
        v = str(valor or "").strip()
        if not email and _parece_email(v):
            email = v
        elif not telefono and _parece_telefono(v):
            telefono = v

    ad_id = str(datos.get("ad_id") or "")
    adset_id = str(datos.get("adset_id") or "")
    campaign_id = str(datos.get("campaign_id") or "")

    db.execute(
        text("""INSERT INTO meta_lead_events
                (company_id, page_id, form_id, leadgen_id, ad_id, campaign_id, adset_id,
                 form_fields_json, payload_json, contact_phone, contact_email, contact_name)
                VALUES (:cid, :pid, :fid, :lid, :aid, :camp, :adset, :ff, :pl, :cp, :ce, :cn)"""),
        {"cid": company_id, "pid": page_id[:120], "fid": str(datos.get("form_id") or "")[:120],
         "lid": leadgen_id[:120], "aid": ad_id[:120], "camp": campaign_id[:120],
         "adset": adset_id[:120],
         "ff": json.dumps(campos, ensure_ascii=False),
         "pl": json.dumps(datos, ensure_ascii=False),
         "cp": telefono[:60], "ce": email[:160], "cn": (nombre or "Lead de formulario")[:180]},
    )
    db.commit()

    if not (telefono or email):
        return {"ok": True, "ingested": True, "contact_id": None, "reason": "sin_datos_de_contacto"}

    # Mismo criterio de match que el resto del CRM: por los ultimos 8 digitos,
    # porque el mismo numero argentino llega como 549341..., 54341... o 341...
    solo_digitos = re.sub(r"\D", "", telefono)
    contacto = None
    if solo_digitos:
        contacto = db.execute(
            text(r"""SELECT id FROM contacts WHERE "companyId" = :c
                     AND RIGHT(REGEXP_REPLACE(COALESCE(number,''), '\D', '', 'g'), 8) = :suf
                     LIMIT 1"""),
            {"c": company_id, "suf": solo_digitos[-8:]},
        ).mappings().first()
    if not contacto and email:
        contacto = db.execute(
            text('SELECT id FROM contacts WHERE "companyId" = :c '
                 "AND LOWER(COALESCE(email,'')) = :e LIMIT 1"),
            {"c": company_id, "e": email.lower()},
        ).mappings().first()

    # Lo que el lead respondio en el formulario (proyecto, presupuesto, etapa) es
    # la mejor informacion que hay de el. Sin esto queda solo el nombre y el
    # asesor tiene que volver a preguntar todo.
    usados = {telefono, email, nombre}
    resumen = " | ".join(
        "%s: %s" % (k.replace("_", " ").strip(" :?¿"), v)
        for k, v in campos.items() if v and str(v).strip() not in usados
    )[:1000]

    if contacto:
        contact_id = contacto["id"]
        # Ya escribio por WhatsApp y ademas dejo el formulario: se completa lo
        # que falte, sin pisar lo que el contacto ya tiene cargado.
        db.execute(
            text('UPDATE contacts SET email = COALESCE(NULLIF(email, \'\'), :e), '
                 'name = COALESCE(NULLIF(name, \'\'), :n), '
                 'needs = COALESCE(NULLIF(needs, \'\'), :r), "updatedAt" = NOW() WHERE id = :i'),
            {"e": email or None, "n": (nombre or None), "r": resumen or None, "i": contact_id},
        )
    else:
        etapa = db.execute(
            text("SELECT id FROM lead_stages WHERE company_id = :c ORDER BY position, id LIMIT 1"),
            {"c": company_id},
        ).scalar()
        contact_id = db.execute(
            text("""INSERT INTO contacts
                    (name, number, email, source, "leadStatus", "companyId", stage_id,
                     needs, "createdAt", "updatedAt")
                    VALUES (:n, :ph, :em, 'meta_lead_ads', 'new', :cid, :st, :r, NOW(), NOW())
                    RETURNING id"""),
            {"n": (nombre or "Lead de formulario")[:180], "ph": telefono or None,
             "em": email or None, "cid": company_id, "st": etapa, "r": resumen or None},
        ).scalar()
    db.commit()

    try:
        ad_attribution.save(db, company_id, contact_id, ad_id,
                            adset_id=adset_id, campaign_id=campaign_id)
        red = {"fb": "Facebook", "ig": "Instagram"}.get(str(datos.get("platform") or ""), "Meta")
        pago = "" if datos.get("is_organic") else " (pago)"
        detalle = _nombre_form(db, company_id, page_id, str(datos.get("form_id") or "")) or ""
        ad_attribution.set_origen(db, company_id, contact_id, ad_attribution.ORIGEN_FORMULARIO,
                                  ("%s · %s%s" % (detalle, red, pago)).strip(" ·") if detalle
                                  else "%s%s" % (red, pago))
    except Exception as e:  # noqa: BLE001
        log.warning("lead ads: no se pudo guardar la atribucion (%s)", str(e)[:120])
        db.rollback()

    log.info("lead ads: lead %s de la empresa %s -> contacto %s", leadgen_id, company_id, contact_id)
    return {"ok": True, "ingested": True, "contact_id": contact_id,
            "nombre": nombre, "telefono": telefono, "email": email}
