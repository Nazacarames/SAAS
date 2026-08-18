"""De que aviso viene cada lead.

Meta manda el id del aviso en dos lugares distintos y una sola vez:
  - Click to WhatsApp / IG / Messenger: el bloque `referral` del PRIMER mensaje.
  - Formulario (Lead Ads): los campos ad_id / adset_id / campaign_id del lead.

Ese id se guarda en el contacto apenas llega, porque despues no vuelve. Los
nombres (campaña, conjunto, aviso) se resuelven aparte contra Graph y se
cachean: son lo unico legible para el equipo, pero requieren un token con
ads_read y no siempre esta.

Es atribucion de primer contacto: la pauta que trajo a la persona no se pisa si
mas adelante vuelve a entrar por otro aviso.
"""

import re
import logging

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.ads")

GRAPH = "https://graph.facebook.com/v21.0"

_cols_listas = False


def _ensure(db: Session) -> None:
    global _cols_listas
    if _cols_listas:
        return
    db.execute(text('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_id VARCHAR(60)'))
    db.execute(text('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_name VARCHAR(255)'))
    db.execute(text('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS adset_name VARCHAR(255)'))
    db.execute(text('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(255)'))
    # de donde vino el lead, en una palabra, y el detalle legible
    db.execute(text('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS origen VARCHAR(20)'))
    db.execute(text('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS origen_detalle VARCHAR(255)'))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS meta_ads_catalog (
            ad_id VARCHAR(60) PRIMARY KEY,
            company_id INTEGER,
            ad_name VARCHAR(255),
            adset_name VARCHAR(255),
            campaign_name VARCHAR(255),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    db.commit()
    _cols_listas = True


def _token(db: Session, company_id: int) -> str:
    """Mismo criterio que el pixel: primero el token que autorizo el cliente por
    OAuth sobre SU cuenta publicitaria. El de la conexion puede ser el del
    proveedor, que no ve las campañas del cliente y devuelve los nombres vacios."""
    from app.services.crypto import decrypt
    from app.services.meta_pixel import _read_settings
    ads = decrypt(str((_read_settings(db, company_id) or {}).get("metaAdsToken") or ""))
    if ads:
        return ads
    row = db.execute(
        text("SELECT access_token FROM meta_connections WHERE company_id = :c "
             "AND access_token IS NOT NULL ORDER BY id DESC LIMIT 1"),
        {"c": company_id},
    ).scalar()
    return decrypt(row or "")


def _nombre_de(cli: httpx.Client, token: str, obj_id: str) -> str:
    if not obj_id:
        return ""
    try:
        r = cli.get(f"{GRAPH}/{obj_id}", params={"access_token": token, "fields": "name"}).json()
        return str(r.get("name") or "")[:255]
    except Exception:
        return ""


def resolve(db: Session, company_id: int, ad_id: str = "",
            adset_id: str = "", campaign_id: str = "") -> dict:
    """Nombres legibles del aviso. Cacheados: el nombre no cambia seguido y
    cada consulta es una llamada a Meta."""
    _ensure(db)
    vacio = {"ad_name": "", "adset_name": "", "campaign_name": ""}
    if ad_id:
        fila = db.execute(
            text("SELECT ad_name, adset_name, campaign_name FROM meta_ads_catalog WHERE ad_id = :a"),
            {"a": ad_id},
        ).mappings().first()
        if fila:
            return dict(fila)

    token = _token(db, company_id)
    if not token:
        return vacio
    try:
        with httpx.Client(timeout=20) as cli:
            datos = dict(vacio)
            if ad_id:
                r = cli.get(f"{GRAPH}/{ad_id}", params={
                    "access_token": token,
                    "fields": "name,adset{name},campaign{name}"}).json()
                if r.get("error"):
                    # Token sin permiso sobre ese aviso (o de otra cuenta): se
                    # guarda igual el id crudo y el equipo lo puede buscar a mano.
                    log.info("ads: no se pudo leer el aviso %s (%s)", ad_id,
                             r["error"].get("message", "")[:80])
                    return vacio
                datos = {
                    "ad_name": str(r.get("name") or "")[:255],
                    "adset_name": str((r.get("adset") or {}).get("name") or "")[:255],
                    "campaign_name": str((r.get("campaign") or {}).get("name") or "")[:255],
                }
            else:
                datos["adset_name"] = _nombre_de(cli, token, adset_id)
                datos["campaign_name"] = _nombre_de(cli, token, campaign_id)
    except Exception as e:
        log.info("ads: fallo la consulta de nombres (%s)", str(e)[:80])
        return vacio

    if ad_id and any(datos.values()):
        db.execute(
            text("INSERT INTO meta_ads_catalog (ad_id, company_id, ad_name, adset_name, campaign_name) "
                 "VALUES (:a, :c, :an, :sn, :cn) ON CONFLICT (ad_id) DO UPDATE SET "
                 "ad_name = EXCLUDED.ad_name, adset_name = EXCLUDED.adset_name, "
                 "campaign_name = EXCLUDED.campaign_name, updated_at = NOW()"),
            {"a": ad_id, "c": company_id, "an": datos["ad_name"],
             "sn": datos["adset_name"], "cn": datos["campaign_name"]},
        )
        db.commit()
    return datos


def save(db: Session, company_id: int, contact_id: int, ad_id: str = "",
         adset_id: str = "", campaign_id: str = "") -> dict:
    """Guarda de que aviso vino el contacto. No pisa una atribucion anterior."""
    _ensure(db)
    ad_id = str(ad_id or "").strip()
    if not (ad_id or adset_id or campaign_id):
        return {}
    ya = db.execute(
        text('SELECT ad_id, campaign_name FROM contacts WHERE id = :i AND "companyId" = :c'),
        {"i": contact_id, "c": company_id},
    ).mappings().first()
    if not ya:
        return {}
    if ya["ad_id"] or ya["campaign_name"]:
        return dict(ya)

    datos = resolve(db, company_id, ad_id, adset_id, campaign_id)
    db.execute(
        text('UPDATE contacts SET ad_id = :a, ad_name = :an, adset_name = :sn, '
             'campaign_name = :cn, "updatedAt" = NOW() WHERE id = :i'),
        {"a": ad_id or None, "an": datos["ad_name"] or None,
         "sn": datos["adset_name"] or None, "cn": datos["campaign_name"] or None,
         "i": contact_id},
    )
    db.commit()
    return {"ad_id": ad_id, **datos}


def por_campana(db: Session, company_id: int, dias: int = 30) -> list[dict]:
    """Leads y ventas agrupados por campaña: con esto se ve que pauta trae
    gente que compra y cual solo trae consultas."""
    _ensure(db)
    from app.services import meta_pixel
    meta_pixel._ensure_table(db)  # el cruce con ventas necesita lead_conversions
    filas = db.execute(
        text("""SELECT COALESCE(NULLIF(c.campaign_name, ''), NULLIF(c.ad_name, ''),
                        CASE WHEN c.ad_id IS NOT NULL THEN 'Aviso ' || c.ad_id END,
                        'Sin pauta identificada') AS campana,
                       COUNT(DISTINCT c.id) AS leads,
                       COUNT(DISTINCT lc.contact_id) AS ventas,
                       COALESCE(SUM(lc.value), 0) AS monto
                FROM contacts c
                LEFT JOIN lead_conversions lc ON lc.contact_id = c.id
                WHERE c."companyId" = :c
                  AND c."createdAt" >= NOW() - (:d || ' days')::interval
                GROUP BY 1
                ORDER BY ventas DESC, leads DESC
                LIMIT 12"""),
        {"c": company_id, "d": str(dias)},
    ).mappings().all()
    return [{"campana": f["campana"], "leads": int(f["leads"] or 0),
             "ventas": int(f["ventas"] or 0), "monto": float(f["monto"] or 0)} for f in filas]


# ── de donde vino el lead ─────────────────────────────────────────
# Redes y acortadores: un link a estos NO significa que el lead venga de la web
# del cliente (suele ser el propio cliente pasando su Instagram, o spam).
_DOMINIOS_SOCIALES = (
    "facebook.com", "fb.me", "instagram.com", "ig.me", "wa.me", "whatsapp.com",
    "youtube.com", "youtu.be", "tiktok.com", "twitter.com", "x.com", "linkedin.com",
    "t.me", "bit.ly", "linktr.ee", "goo.gl", "maps.app.goo.gl", "google.com",
)

ORIGEN_PAUTA = "pauta"
ORIGEN_FORMULARIO = "formulario"
ORIGEN_WEB = "web"
ORIGEN_ORGANICO = "organico"


def dominio_de_texto(texto: str) -> str:
    """Dominio del primer link que no sea de una red social. Es la señal de que
    el lead venía navegando la web del cliente y de ahí abrió el chat."""
    for url in re.findall(r"https?://[^\s<>\]\)]+", str(texto or "")):
        host = re.sub(r"^www\.", "", url.split("//", 1)[-1].split("/")[0].lower())
        if host and not any(host == d or host.endswith("." + d) for d in _DOMINIOS_SOCIALES):
            return host[:255]
    return ""


def sitio_de(db: Session, company_id: int) -> str:
    """Dominio propio del cliente (company_runtime_settings.sitioWeb).

    Sin esto, cualquier link contaba como "vino de la web": el primer backfill
    marcó como lead web a una agencia que le mandó spam a Reno con su propio
    sitio. Un origen mal atribuido es peor que no tenerlo.
    """
    import json as _json
    raw = db.execute(
        text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :c"),
        {"c": company_id},
    ).scalar()
    try:
        cfg = _json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        cfg = {}
    dom = str(cfg.get("sitioWeb") or "").strip().lower()
    return re.sub(r"^(https?://)?(www\.)?", "", dom).strip("/")


def es_del_cliente(db: Session, company_id: int, dominio: str) -> bool:
    propio = sitio_de(db, company_id)
    if not propio or not dominio:
        return False
    return dominio == propio or dominio.endswith("." + propio)


def set_origen(db: Session, company_id: int, contact_id: int,
               origen: str, detalle: str = "") -> None:
    """Primer contacto manda: si el lead ya tiene un origen mejor que 'organico'
    no se pisa. El origen es de por vida, no del último mensaje."""
    _ensure(db)
    actual = db.execute(
        text('SELECT origen FROM contacts WHERE id = :i AND "companyId" = :c'),
        {"i": contact_id, "c": company_id},
    ).scalar()
    if actual and actual != ORIGEN_ORGANICO:
        return
    db.execute(
        text('UPDATE contacts SET origen = :o, origen_detalle = COALESCE(NULLIF(:d, ''), origen_detalle), '
             '"updatedAt" = NOW() WHERE id = :i'),
        {"o": origen, "d": (detalle or "")[:255], "i": contact_id},
    )
    db.commit()


def registrar_entrada(db: Session, company_id: int, contact_id: int, texto: str,
                      ad_id: str = "") -> str:
    """Clasifica de dónde entró el lead con lo que se sabe en su primer mensaje."""
    if ad_id:
        datos = save(db, company_id, contact_id, ad_id)
        set_origen(db, company_id, contact_id, ORIGEN_PAUTA,
                   datos.get("campaign_name") or datos.get("ad_name") or ("Aviso " + ad_id))
        return ORIGEN_PAUTA
    dominio = dominio_de_texto(texto)
    if dominio and es_del_cliente(db, company_id, dominio):
        set_origen(db, company_id, contact_id, ORIGEN_WEB, dominio)
        return ORIGEN_WEB
    # el dominio ajeno igual se guarda como dato de contexto, pero NO cuenta
    # como que el lead vino de la web del cliente
    set_origen(db, company_id, contact_id, ORIGEN_ORGANICO, dominio)
    return ORIGEN_ORGANICO
