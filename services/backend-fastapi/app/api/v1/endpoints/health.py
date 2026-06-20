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
    rows = db.execute(
        text(
            """SELECT w.id, w.name, w."companyId",
                      s.settings_json
               FROM whatsapps w
               LEFT JOIN company_runtime_settings s ON s.company_id = w."companyId"
               WHERE w.status = 'CONNECTED'"""
        )
    ).mappings().all()

    results = []
    for r in rows:
        import json
        settings_json = r.get("settings_json") or "{}"
        try:
            cfg = json.loads(settings_json) if isinstance(settings_json, str) else settings_json
        except Exception:
            cfg = {}

        token = cfg.get("wa_cloud_access_token", "")
        phone_id = cfg.get("wa_cloud_phone_number_id", "")

        if not token or not phone_id:
            results.append({
                "companyId": r["companyId"],
                "name": r["name"],
                "status": "not_configured",
                "detail": "Token o Phone ID no configurado",
            })
            continue

        try:
            resp = httpx.get(
                f"https://graph.facebook.com/v21.0/{phone_id}",
                params={"access_token": token},
                timeout=8,
            )
            if resp.status_code == 200:
                data = resp.json()
                results.append({
                    "companyId": r["companyId"],
                    "name": r["name"],
                    "status": "valid",
                    "verified_name": data.get("verified_name", ""),
                    "display_phone": data.get("display_phone_number", ""),
                })
            else:
                error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                err_msg = error_data.get("error", {}).get("message", resp.text[:100])
                err_code = error_data.get("error", {}).get("code", resp.status_code)
                results.append({
                    "companyId": r["companyId"],
                    "name": r["name"],
                    "status": "expired" if err_code == 190 else "error",
                    "detail": err_msg,
                    "error_code": err_code,
                })
        except Exception as e:
            results.append({
                "companyId": r["companyId"],
                "name": r["name"],
                "status": "unreachable",
                "detail": str(e)[:200],
            })

    all_valid = all(r["status"] == "valid" for r in results) if results else True
    return {
        "status": "ok" if all_valid else "warning",
        "tokens": results,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
