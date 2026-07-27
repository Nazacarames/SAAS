"""
Facetas del inventario Tokko por empresa: qué tipos de propiedad, operaciones
y zonas EXISTEN de verdad, para que el agente ofrezca esas opciones al preguntar
(y no deje que el cliente pida algo que no hay).

Se inyecta como bloque en el system prompt (ver _build_system_prompt). Cacheado
6 h por worker; una pasada por el inventario completo (páginas de 200).
"""
from __future__ import annotations

import json
import logging
from collections import Counter

import httpx
from sqlalchemy import text

log = logging.getLogger("app.tokko_facets")

FACETS_TTL = 6 * 3600
MAX_PROPS = 1000

_TYPE_ES = {
    "apartment": "Departamento", "house": "Casa", "ph": "PH", "condo": "Departamento",
    "office": "Oficina", "bussiness premises": "Local comercial", "business premises": "Local comercial",
    "land": "Terreno", "garage": "Cochera", "warehouse": "Galpón", "countryside": "Campo",
    "hotel": "Hotel", "building": "Edificio",
}


def _type_name(raw) -> str:
    name = str(raw.get("name") if isinstance(raw, dict) else raw or "").strip()
    return _TYPE_ES.get(name.lower(), name)


def _compute(company_id: int) -> str:
    from app.core.db import SessionLocal
    db = SessionLocal()
    try:
        row = db.execute(
            text("SELECT tokko_api_key, tokko_base_url FROM companies WHERE id = :cid"), {"cid": company_id}
        ).mappings().first()
    finally:
        db.close()
    if not row or not row["tokko_api_key"]:
        return ""
    key = row["tokko_api_key"]
    base = (row["tokko_base_url"] or "https://www.tokkobroker.com/api/v1").rstrip("/")

    data = json.dumps({
        "operation_types": [1, 2],
        "property_types": [1, 2, 3, 4, 5, 7, 10, 13, 23, 24, 25, 26, 27, 30, 31],
        "price_from": 0, "price_to": 99999999, "currency": "ANY",
    })
    types: Counter = Counter()
    zones: Counter = Counter()
    ops: Counter = Counter()
    fetched, offset = 0, 0
    try:
        with httpx.Client(timeout=30) as client:
            while fetched < MAX_PROPS:
                r = client.get(f"{base}/property/search/", params={
                    "key": key, "limit": 200, "offset": offset, "format": "json", "data": data,
                })
                if r.status_code != 200:
                    break
                objs = (r.json() or {}).get("objects") or []
                if not objs:
                    break
                for p in objs:
                    types[_type_name(p.get("type"))] += 1
                    loc = str((p.get("location") or {}).get("full_location") or "")
                    segs = [s.strip() for s in loc.split("|") if s.strip()]
                    if segs:
                        zones[segs[-1]] += 1
                    for op in p.get("operations", []) or []:
                        o = str(op.get("operation_type", "")).lower()
                        if o in ("rent", "alquiler", "rental"):
                            ops["Alquiler"] += 1
                        elif o in ("sale", "venta"):
                            ops["Venta"] += 1
                fetched += len(objs)
                if len(objs) < 200:
                    break
                offset += 200
    except Exception as e:
        log.warning("facets fetch failed company=%s: %s", company_id, str(e)[:120])
    if not fetched:
        return ""

    fmt = lambda c, n: ", ".join(f"{k} ({v})" for k, v in c.most_common(n))
    return (
        "INVENTARIO REAL DISPONIBLE (actualizado automáticamente desde el sistema de propiedades; "
        f"total {fetched} propiedades):\n"
        f"- Operaciones: {fmt(ops, 3)}\n"
        f"- Tipos de propiedad: {fmt(types, 10)}\n"
        f"- Zonas con propiedades: {fmt(zones, 12)}\n"
        "REGLA IMPORTANTE: cuando le preguntes al cliente el tipo de propiedad, la operación o la zona, "
        "ofrecele SIEMPRE las opciones de esta lista (las de mayor stock primero, máximo 6, sin los números). "
        "Si pide un tipo o zona que NO figura acá, avisale con honestidad que no tenemos disponibles y "
        "ofrecé las alternativas más parecidas de la lista. Nunca prometas buscar algo que no existe en el inventario.\n"
    )


def facets_block(company_id: int) -> str:
    """Bloque para el system prompt; '' si la empresa no tiene Tokko."""
    try:
        from app.services.cache import get_or_set
        return get_or_set(f"tokko_facets:{company_id}", FACETS_TTL, lambda: _compute(company_id))
    except Exception:
        return ""
