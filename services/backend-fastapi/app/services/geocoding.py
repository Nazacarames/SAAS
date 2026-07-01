"""
Geocoding for the "near X" property search feature.

Resolves a free-text place name (landmark, hospital, plaza, street) mentioned
by a client to lat/lon coordinates via OpenStreetMap Nominatim (free, no API
key). Results are cached in `geocode_cache` — the cache is global, not
per-company, because a place's coordinates are the same fact for every tenant.

No paid API is wired in for v1 (all current companies are Argentine real
estate agencies and OSM resolves landmarks/plazas/hospitals/stations well
enough). DEFAULT_GEOCODE_COUNTRY biases results to Argentina; if a future
company operates elsewhere this constant is the one place to change.
"""
from __future__ import annotations

import logging
import math
import re
from typing import Optional

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.geocoding")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "LMTM-CRM/1.0 (contacto@lmtmas.com)"
DEFAULT_GEOCODE_COUNTRY = "ar"


def _normalize_query(q: str) -> str:
    return re.sub(r"\s+", " ", (q or "").strip().lower())


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points, in kilometers."""
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def _get_cached(db: Session, normalized: str) -> Optional[dict]:
    row = db.execute(
        text("SELECT lat, lon, display_name FROM geocode_cache WHERE query_normalized = :q LIMIT 1"),
        {"q": normalized},
    ).mappings().first()
    if not row:
        return None
    return {"lat": row["lat"], "lon": row["lon"], "display_name": row["display_name"] or ""}


def _store_cache(db: Session, normalized: str, original: str, lat: float, lon: float, display_name: str) -> None:
    try:
        db.execute(
            text(
                "INSERT INTO geocode_cache (query_normalized, query_original, lat, lon, display_name) "
                "VALUES (:qn, :qo, :lat, :lon, :dn) "
                "ON CONFLICT (query_normalized) DO NOTHING"
            ),
            {"qn": normalized, "qo": original[:255], "lat": lat, "lon": lon, "dn": display_name},
        )
        db.commit()
    except Exception:
        db.rollback()


async def geocode(query: str, db: Session) -> Optional[dict]:
    """Resolve a place name to {"lat", "lon", "display_name"}, or None if unresolved.

    Never raises — any failure (bad query, network error, no results) yields None
    so callers can gracefully skip the near-filter instead of breaking the search.
    """
    if not query or not query.strip():
        return None

    normalized = _normalize_query(query)
    if not normalized:
        return None

    cached = _get_cached(db, normalized)
    if cached:
        return cached

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                NOMINATIM_URL,
                params={
                    "q": query.strip(),
                    "format": "json",
                    "limit": 1,
                    "countrycodes": DEFAULT_GEOCODE_COUNTRY,
                },
                headers={"User-Agent": USER_AGENT},
                timeout=10,
            )
        if resp.status_code != 200:
            log.warning("geocode failed status=%s query=%r", resp.status_code, query)
            return None
        results = resp.json()
        if not results:
            return None
        r = results[0]
        lat, lon = float(r["lat"]), float(r["lon"])
        display_name = r.get("display_name", "")
        _store_cache(db, normalized, query, lat, lon, display_name)
        return {"lat": lat, "lon": lon, "display_name": display_name}
    except Exception as e:
        log.warning("geocode exception query=%r err=%s", query, str(e)[:200])
        return None
