"""
Geocoding for the "near X" property search feature.

Resolves a free-text place name (landmark, hospital, plaza, street) mentioned
by a client to lat/lon coordinates via OpenStreetMap Nominatim (free, no API
key).

Disambiguation: Argentina has many places sharing a name (e.g. a "Plaza San
Martín" in almost every city), and clients usually omit the city because it's
obvious to them. `geocode` therefore accepts an optional bias point — the
company's property centroid — and passes it to Nominatim as a `viewbox` soft
bias so an ambiguous name resolves to the region where the agency actually has
stock. Results are cached per (query, region_bucket), because the same name can
correctly resolve to different coordinates for agencies in different regions.

No paid API is wired in for v1. DEFAULT_GEOCODE_COUNTRY biases to Argentina; if
a future company operates elsewhere this constant is the one place to change.
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
VIEWBOX_HALF_DEG = 0.7  # ~78 km half-box around the bias point (covers a metro area + margin)


def _normalize_query(q: str) -> str:
    return re.sub(r"\s+", " ", (q or "").strip().lower())


def _region_bucket(bias_lat: Optional[float], bias_lon: Optional[float]) -> str:
    if bias_lat is None or bias_lon is None:
        return "global"
    return f"{round(bias_lat)},{round(bias_lon)}"


def _viewbox(bias_lat: float, bias_lon: float) -> str:
    # Nominatim viewbox order: lon_min,lat_max,lon_max,lat_min
    return f"{bias_lon - VIEWBOX_HALF_DEG},{bias_lat + VIEWBOX_HALF_DEG},{bias_lon + VIEWBOX_HALF_DEG},{bias_lat - VIEWBOX_HALF_DEG}"


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lon points, in kilometers."""
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def _get_cached(db: Session, normalized: str, bucket: str) -> Optional[dict]:
    row = db.execute(
        text(
            "SELECT lat, lon, display_name FROM geocode_cache "
            "WHERE query_normalized = :q AND region_bucket = :b LIMIT 1"
        ),
        {"q": normalized, "b": bucket},
    ).mappings().first()
    if not row:
        return None
    return {"lat": row["lat"], "lon": row["lon"], "display_name": row["display_name"] or ""}


def _store_cache(db: Session, normalized: str, bucket: str, original: str, lat: float, lon: float, display_name: str) -> None:
    try:
        db.execute(
            text(
                "INSERT INTO geocode_cache (query_normalized, region_bucket, query_original, lat, lon, display_name) "
                "VALUES (:qn, :b, :qo, :lat, :lon, :dn) "
                "ON CONFLICT (query_normalized, region_bucket) DO NOTHING"
            ),
            {"qn": normalized, "b": bucket, "qo": original[:255], "lat": lat, "lon": lon, "dn": display_name},
        )
        db.commit()
    except Exception:
        db.rollback()


async def geocode(
    query: str,
    db: Session,
    bias_lat: Optional[float] = None,
    bias_lon: Optional[float] = None,
) -> Optional[dict]:
    """Resolve a place name to {"lat", "lon", "display_name"}, or None if unresolved.

    If bias_lat/bias_lon are given (the company's property centroid), the lookup
    is biased toward that region so ambiguous names resolve to where the agency
    works. Never raises — any failure yields None so callers can skip the
    near-filter gracefully instead of breaking the search.
    """
    if not query or not query.strip():
        return None

    normalized = _normalize_query(query)
    if not normalized:
        return None

    bucket = _region_bucket(bias_lat, bias_lon)

    cached = _get_cached(db, normalized, bucket)
    if cached:
        return cached

    params = {
        "q": query.strip(),
        "format": "json",
        "limit": 1,
        "countrycodes": DEFAULT_GEOCODE_COUNTRY,
    }
    if bias_lat is not None and bias_lon is not None:
        params["viewbox"] = _viewbox(bias_lat, bias_lon)  # soft bias (not bounded=1, so it degrades gracefully)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(NOMINATIM_URL, params=params, headers={"User-Agent": USER_AGENT}, timeout=10)
        if resp.status_code != 200:
            log.warning("geocode failed status=%s query=%r", resp.status_code, query)
            return None
        results = resp.json()
        if not results:
            return None
        r = results[0]
        lat, lon = float(r["lat"]), float(r["lon"])
        display_name = r.get("display_name", "")
        _store_cache(db, normalized, bucket, query, lat, lon, display_name)
        return {"lat": lat, "lon": lon, "display_name": display_name}
    except Exception as e:
        log.warning("geocode exception query=%r err=%s", query, str(e)[:200])
        return None
