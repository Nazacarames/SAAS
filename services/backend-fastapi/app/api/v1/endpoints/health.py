import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.db import get_db

router = APIRouter()
log = logging.getLogger("app.health")


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/health/deep")
def deep_health(db: Session = Depends(get_db)):
    checks: dict = {}

    try:
        row = db.execute(text("SELECT 1 AS ok")).mappings().first()
        checks["database"] = {"ok": bool(row), "detail": "connected"}
    except Exception as e:
        checks["database"] = {"ok": False, "detail": str(e)[:200]}

    try:
        row = db.execute(
            text("SELECT COUNT(*) AS n FROM companies")
        ).mappings().first()
        checks["companies"] = {"ok": True, "count": row["n"] if row else 0}
    except Exception as e:
        checks["companies"] = {"ok": False, "detail": str(e)[:200]}

    all_ok = all(c.get("ok") for c in checks.values())
    return {"status": "ok" if all_ok else "degraded", "checks": checks, "ts": datetime.now(timezone.utc).isoformat()}


@router.get("/health/whatsapp-tokens")
def check_whatsapp_tokens(db: Session = Depends(get_db)):
    """Validate Meta access tokens for all active channels (WhatsApp/Instagram/Messenger)."""
    import json

    rows = db.execute(
        text(
            """SELECT c.id, c.name, c.company_id, c.channel_type, c.external_id,
                      c.config_json, mc.access_token AS mc_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.status = 'active'
               ORDER BY c.company_id, c.id"""
        )
    ).mappings().all()

    results = []
    for r in rows:
        try:
            cfg = json.loads(r["config_json"]) if isinstance(r["config_json"], str) else (r["config_json"] or {})
        except Exception:
            cfg = {}

        token = r.get("mc_token") or cfg.get("waCloudAccessToken") or ""
        external_id = r["external_id"]
        ctype = r["channel_type"]

        base = {
            "companyId": r["company_id"],
            "name": r["name"],
            "channel_type": ctype,
            "external_id": external_id,
        }

        if not token or not external_id:
            results.append({**base, "status": "not_configured", "detail": "Token o ID no configurado"})
            continue

        # Per-channel Graph fields
        if ctype == "whatsapp":
            fields = "display_phone_number,verified_name"
        elif ctype == "instagram":
            fields = "name,username"
        elif ctype == "messenger":
            fields = "name,category"
        else:
            fields = "name"

        try:
            resp = httpx.get(
                f"https://graph.facebook.com/v21.0/{external_id}",
                params={"access_token": token, "fields": fields},
                timeout=8,
            )
            if resp.status_code == 200:
                data = resp.json()
                results.append({
                    **base,
                    "status": "valid",
                    "verified_name": data.get("verified_name") or data.get("name") or data.get("username", ""),
                    "display_phone": data.get("display_phone_number", ""),
                })
            else:
                error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                err_msg = error_data.get("error", {}).get("message", resp.text[:100])
                err_code = error_data.get("error", {}).get("code", resp.status_code)
                results.append({
                    **base,
                    "status": "expired" if err_code == 190 else "error",
                    "detail": err_msg,
                    "error_code": err_code,
                })
        except Exception as e:
            results.append({**base, "status": "unreachable", "detail": str(e)[:200]})

    all_valid = all(r["status"] == "valid" for r in results) if results else True
    return {
        "status": "ok" if all_valid else "warning",
        "tokens": results,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
