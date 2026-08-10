"""Leads que entran desde un aviso de Facebook/Instagram (Click to WhatsApp).

Cuando alguien toca "Enviar mensaje" en un aviso, Meta adjunta al primer
mensaje un bloque `referral` con el titular, el texto y el link del aviso. Ese
dato dura un solo mensaje: si no se lee ahí, se pierde y el lead queda como
cualquier otro.

Con eso se hacen dos cosas: saludar reconociendo por dónde entró, y mandarle la
ficha de la propiedad del aviso. El cliente venía mirando ESA propiedad; hacerle
la rutina de "¿en qué zona buscás?" es hacerle repetir lo que ya eligió.

Cómo se encuentra la propiedad, en orden de confianza:
  1. El link del aviso trae el id de la ficha (ficha.info/p/XXXX). Match exacto.
  2. El titular o el cuerpo del aviso nombran la dirección. Se compara contra
     los títulos de la cartera y se exige un margen claro sobre el segundo
     candidato: ante la duda no se manda ficha, porque mostrar la propiedad
     equivocada es peor que no mostrar ninguna.
"""
import logging
import re
import unicodedata

from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.ads")

# El rubro decide: mandar una ficha de propiedad al lead de una gomeria no tiene
# sentido. El saludo reconociendo el aviso, en cambio, sirve para cualquiera.
_RUBROS_INMO = ("inmobiliaria", "real estate", "realestate", "agencia inmobiliaria", "broker")


def extract_referral(msg: dict) -> dict:
    """Normaliza el bloque de aviso de WhatsApp, Messenger o Instagram."""
    if not isinstance(msg, dict):
        return {}
    ref = msg.get("referral") or (msg.get("message") or {}).get("referral") or {}
    if not isinstance(ref, dict) or not ref:
        return {}
    ctx = ref.get("ads_context_data") or {}
    fuente = str(ref.get("source_type") or ref.get("source") or "").lower()
    if fuente and fuente not in ("ad", "ads", "post"):
        return {}
    return {
        "ad_id": str(ref.get("source_id") or ref.get("ad_id") or ""),
        "titular": str(ref.get("headline") or ctx.get("ad_title") or "").strip(),
        "cuerpo": str(ref.get("body") or "").strip(),
        "url": str(ref.get("source_url") or "").strip(),
        "foto": str(ref.get("image_url") or ctx.get("photo_url") or "").strip(),
    }


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]", " ", s.lower())


_RUIDO = {"casa", "departamento", "depto", "ph", "local", "oficina", "terreno", "lote", "venta",
          "vende", "alquiler", "propiedad", "amb", "ambientes", "dormitorios", "usd", "ars",
          "en", "de", "la", "el", "los", "las", "con", "y", "a", "al", "por", "para", "un", "una"}


def _tokens(s: str) -> set:
    return {t for t in _norm(s).split() if len(t) > 2 and t not in _RUIDO}


def is_real_estate(db: Session, company_id: int) -> bool:
    try:
        ind = db.execute(text("SELECT lower(COALESCE(industry, '')) FROM companies WHERE id = :c"),
                         {"c": company_id}).scalar() or ""
        return ind in _RUBROS_INMO
    except Exception:
        return False


async def match_by_text(db: Session, company_id: int, texto: str) -> dict | None:
    """Propiedad que nombra un texto suelto (el primer mensaje del cliente).

    Los avisos de Click to WhatsApp abren el chat con un mensaje ya escrito que
    nombra la propiedad ("Hola, me interesa Mendoza al 300"). Ese texto es la
    unica pista fiable: el bloque referral de Meta no siempre llega, sobre todo
    cuando el numero se atiende tambien desde el celular.
    """
    return await match_property(db, company_id, {"titular": texto, "cuerpo": "", "url": ""})


async def match_property(db: Session, company_id: int, ref: dict) -> dict | None:
    """Propiedad del aviso, o None si no se puede afirmar cuál es."""
    from app.services.conversation_orchestrator import execute_tool

    texto = " ".join([ref.get("titular", ""), ref.get("cuerpo", "")]).strip()
    url = ref.get("url", "")
    if not texto and not url:
        return None

    try:
        res = await execute_tool(tool_name="search_properties",
                                 tool_args={"operation_type": "sale", "location": "", "price_max": 0},
                                 company_id=company_id, db=db)
        props = res.get("results") or []
    except Exception as e:
        log.warning("match_property company=%s: %s", company_id, str(e)[:120])
        return None
    if not props:
        return None

    # 1) el link del aviso lleva a la ficha
    m = re.search(r"/p/([A-Za-z0-9_-]{6,})", url)
    if m:
        clave = m.group(1)
        for p in props:
            if clave in str(p.get("url") or ""):
                return p

    # 2) por texto del aviso contra los titulos de la cartera.
    # Primero SOLO el titular: el cuerpo suele ser puro relleno comercial
    # ("Consultanos por este inmueble") y diluye el puntaje hasta hacerlo
    # fallar. Si el titular no alcanza, recien ahi se suma el cuerpo.
    for fuente in (ref.get("titular", ""), texto):
        objetivo = _tokens(fuente)
        if len(objetivo) < 2:
            continue
        puntajes = []
        for p in props:
            # solo el titulo: la ubicacion mete "Rosario", "Santa Fe" y
            # "Argentina" en todas las fichas y empata a media cartera
            cand = _tokens(p.get("title") or "")
            if not cand:
                continue
            if len(cand) < 2:
                continue  # un titulo de una sola palabra matchea con cualquier cosa
            comunes = objetivo & cand
            if comunes:
                # Se mide cuanto del TITULO aparece en el texto, no al reves:
                # normalizando por el largo del mensaje, un "Hola! Me interesa X,
                # quiero mas informacion" diluye el puntaje y nunca matchea.
                puntajes.append((len(comunes) / len(cand), p))
        if not puntajes:
            continue
        puntajes.sort(key=lambda x: x[0], reverse=True)
        mejor, prop = puntajes[0]
        # El margen se mide contra la mejor candidata con OTRO titulo: la misma
        # propiedad suele estar cargada dos veces en la cartera y ese empate
        # consigo misma no es ambiguedad, es un duplicado.
        _t0 = _norm(prop.get("title") or "")
        segundo = next((s for s, q in puntajes[1:] if _norm(q.get("title") or "") != _t0), 0.0)
        # Sin margen claro no se arriesga: mandar la propiedad equivocada es
        # peor que no mandar ninguna y preguntar. Con varias unidades en la
        # misma direccion (un edificio) el empate es real y hay que preguntar.
        if mejor >= 0.6 and (mejor - segundo) >= 0.15:
            return prop
        log.info("aviso company=%s sin match claro (mejor=%.2f segundo=%.2f)", company_id, mejor, segundo)
    return None


def welcome_text(ref: dict, marca: str = "", prop: dict | None = None) -> str:
    """Saludo. Solo se menciona el aviso cuando Meta lo confirmo: si la
    propiedad se dedujo del texto del cliente, afirmar 'venis por el aviso'
    seria inventar por donde entro."""
    quien = (" de %s" % marca) if marca else ""
    titular = (ref or {}).get("titular") or ""
    if titular:
        return ("¡Hola! Gracias por escribirnos%s 👋 Vi que venís por el aviso de *%s*."
                % (quien, titular[:80]))
    if prop:
        return "¡Hola! Gracias por escribirnos%s 👋 Te paso los datos de la propiedad que consultaste." % quien
    return "¡Hola! Gracias por escribirnos%s 👋 Vi que venís por uno de nuestros avisos." % quien


def property_card(prop: dict) -> str:
    """Ficha en el mismo formato que usa el agente, para que el webhook la
    mande como foto + texto sin ningun tratamiento especial."""
    from app.services.conversation_orchestrator import _render_property_results
    return _render_property_results([prop], limit=1)
