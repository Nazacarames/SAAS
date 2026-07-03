"""Super-admin panel: companies, subscriptions, usage, ARCA invoices.

Every endpoint requires profile == 'super' (the platform owner), never
plain company admins.
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db

router = APIRouter(prefix="/admin", tags=["admin"])


def require_super(payload: dict) -> None:
    if payload.get("profile") != "super":
        raise HTTPException(status_code=403, detail="Solo el super admin puede acceder")


@router.get("/overview")
def overview(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    require_super(payload)
    period = datetime.now(timezone.utc).strftime("%Y-%m")
    row = db.execute(text("""
        SELECT
          (SELECT COUNT(*) FROM companies) AS companies,
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM subscriptions s WHERE s.status = 'trialing'
             AND (s."trialEndsAt" IS NULL OR s."trialEndsAt" > NOW())) AS active_trials,
          (SELECT COUNT(*) FROM company_subscriptions cs WHERE cs.status = 'active') AS paying,
          (SELECT COALESCE(SUM(bp.monthly_price_usd), 0) FROM company_subscriptions cs
             JOIN billing_plans bp ON bp.code = cs.plan_code
             WHERE cs.status = 'active' AND bp.code != 'setup') AS mrr_ars
    """)).mappings().first()
    usage = db.execute(text(
        "SELECT metric_code, COALESCE(SUM(metric_value),0) AS total FROM usage_counters WHERE period_ym = :p GROUP BY metric_code"
    ), {"p": period}).mappings().all()
    return {"ok": True, "totals": dict(row), "usage_month": {u["metric_code"]: int(u["total"]) for u in usage}}


@router.get("/companies")
def list_companies(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    require_super(payload)
    period = datetime.now(timezone.utc).strftime("%Y-%m")
    rows = db.execute(text("""
        SELECT c.id, c.name, c.email, c.status AS company_active, c."createdAt" AS created_at,
               cs.plan_code, cs.status AS billing_status, cs.period_end,
               s.status AS sub_status, s."trialEndsAt" AS trial_ends_at, s."billingBypass" AS billing_bypass,
               (SELECT COUNT(*) FROM users u WHERE u."companyId" = c.id) AS users_count,
               (SELECT COUNT(*) FROM channels ch WHERE ch.company_id = c.id AND ch.status = 'active') AS channels_count,
               COALESCE((SELECT uc.metric_value FROM usage_counters uc
                  WHERE uc.company_id = c.id AND uc.period_ym = :p AND uc.metric_code = 'conversations'), 0) AS conversations,
               COALESCE((SELECT uc.metric_value FROM usage_counters uc
                  WHERE uc.company_id = c.id AND uc.period_ym = :p AND uc.metric_code = 'ai_replies'), 0) AS ai_replies
        FROM companies c
        LEFT JOIN company_subscriptions cs ON cs.company_id = c.id
        LEFT JOIN LATERAL (
            SELECT * FROM subscriptions s2 WHERE s2."companyId" = c.id ORDER BY s2.id DESC LIMIT 1
        ) s ON TRUE
        ORDER BY c.id
    """), {"p": period}).mappings().all()
    return {"ok": True, "companies": [dict(r) for r in rows]}


class SubUpdate(BaseModel):
    planCode: str | None = None
    status: str | None = None          # trialing | active | past_due | canceled
    extendTrialDays: int | None = None
    billingBypass: bool | None = None


@router.put("/companies/{company_id}/subscription")
def update_subscription(
    company_id: int,
    body: SubUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_super(payload)

    if body.planCode:
        plan = db.execute(text("SELECT code FROM billing_plans WHERE code = :c AND active = true"),
                          {"c": body.planCode}).mappings().first()
        if not plan:
            raise HTTPException(status_code=400, detail="Plan inválido")
        db.execute(text(
            """INSERT INTO company_subscriptions (company_id, plan_code, status, updated_at)
               VALUES (:cid, :code, 'active', NOW())
               ON CONFLICT (company_id) DO UPDATE SET plan_code = :code, updated_at = NOW()"""
        ), {"cid": company_id, "code": body.planCode})

    if body.status:
        if body.status not in ("trialing", "active", "past_due", "canceled"):
            raise HTTPException(status_code=400, detail="Status inválido")
        db.execute(text("UPDATE company_subscriptions SET status = :st, updated_at = NOW() WHERE company_id = :cid"),
                   {"st": body.status, "cid": company_id})
        db.execute(text('UPDATE subscriptions SET status = :st, "updatedAt" = NOW() WHERE "companyId" = :cid'),
                   {"st": body.status, "cid": company_id})

    if body.extendTrialDays:
        days = max(1, min(int(body.extendTrialDays), 365))
        db.execute(text(
            '''UPDATE subscriptions SET status = 'trialing',
               "trialEndsAt" = GREATEST(COALESCE("trialEndsAt", NOW()), NOW()) + (:d || ' days')::interval,
               "updatedAt" = NOW() WHERE "companyId" = :cid'''
        ), {"d": days, "cid": company_id})
        db.execute(text(
            """UPDATE company_subscriptions SET status = 'trialing',
               period_end = GREATEST(COALESCE(period_end, NOW()), NOW()) + (:d || ' days')::interval,
               updated_at = NOW() WHERE company_id = :cid"""
        ), {"d": days, "cid": company_id})

    if body.billingBypass is not None:
        db.execute(text('UPDATE subscriptions SET "billingBypass" = :b, "updatedAt" = NOW() WHERE "companyId" = :cid'),
                   {"b": body.billingBypass, "cid": company_id})

    db.commit()
    try:
        from app.services.cache import invalidate
        invalidate(f"sub_active:{company_id}")
    except Exception:
        pass
    return {"ok": True}


@router.put("/companies/{company_id}/active")
def toggle_company(
    company_id: int,
    body: dict,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_super(payload)
    active = bool(body.get("active", True))
    db.execute(text('UPDATE companies SET status = :st, "updatedAt" = NOW() WHERE id = :cid'),
               {"st": active, "cid": company_id})
    db.commit()
    return {"ok": True, "active": active}


# ── Plans (full CRUD from the panel; enterprise & custom plans) ──────

class PlanUpsert(BaseModel):
    code: str | None = None          # required on create
    name: str | None = None
    monthlyPriceArs: float | None = None
    limitsJson: str | None = None    # JSON object as string
    featuresJson: str | None = None  # JSON array as string
    active: bool | None = None


def _validate_plan_json(body: PlanUpsert) -> None:
    if body.limitsJson is not None:
        try:
            if not isinstance(json.loads(body.limitsJson), dict):
                raise ValueError
        except Exception:
            raise HTTPException(status_code=400, detail="limitsJson debe ser un objeto JSON válido")
    if body.featuresJson is not None:
        try:
            if not isinstance(json.loads(body.featuresJson), list):
                raise ValueError
        except Exception:
            raise HTTPException(status_code=400, detail="featuresJson debe ser una lista JSON válida")


@router.get("/plans")
def admin_list_plans(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    require_super(payload)
    rows = db.execute(text(
        """SELECT bp.code, bp.name, bp.monthly_price_usd, bp.limits_json, bp.features_json, bp.active,
                  (SELECT COUNT(*) FROM company_subscriptions cs WHERE cs.plan_code = bp.code) AS companies
           FROM billing_plans bp ORDER BY bp.monthly_price_usd ASC"""
    )).mappings().all()
    return {"ok": True, "plans": [dict(r) for r in rows]}


@router.post("/plans")
def admin_create_plan(
    body: PlanUpsert,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_super(payload)
    code = (body.code or "").strip().lower().replace(" ", "_")[:30]
    if not code or not code.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="code inválido (letras/números/guión bajo)")
    if db.execute(text("SELECT 1 FROM billing_plans WHERE code = :c"), {"c": code}).first():
        raise HTTPException(status_code=409, detail="Ya existe un plan con ese code")
    _validate_plan_json(body)
    db.execute(text(
        """INSERT INTO billing_plans (code, name, monthly_price_usd, limits_json, features_json, active)
           VALUES (:c, :n, :p, :l, :f, true)"""
    ), {"c": code, "n": (body.name or code)[:60], "p": body.monthlyPriceArs or 0,
        "l": body.limitsJson or "{}", "f": body.featuresJson or "[]"})
    db.commit()
    return {"ok": True, "code": code}


@router.put("/plans/{code}")
def admin_update_plan(
    code: str,
    body: PlanUpsert,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_super(payload)
    if not db.execute(text("SELECT 1 FROM billing_plans WHERE code = :c"), {"c": code}).first():
        raise HTTPException(status_code=404, detail="Plan no encontrado")
    _validate_plan_json(body)

    updates, params = [], {"c": code}
    if body.name is not None:
        updates.append("name = :n"); params["n"] = body.name[:60]
    if body.monthlyPriceArs is not None:
        updates.append("monthly_price_usd = :p"); params["p"] = body.monthlyPriceArs
    if body.limitsJson is not None:
        updates.append("limits_json = :l"); params["l"] = body.limitsJson
    if body.featuresJson is not None:
        updates.append("features_json = :f"); params["f"] = body.featuresJson
    if body.active is not None:
        updates.append("active = :a"); params["a"] = body.active
    if updates:
        updates.append("updated_at = NOW()")
        db.execute(text(f"UPDATE billing_plans SET {', '.join(updates)} WHERE code = :c"), params)
        db.commit()
    return {"ok": True}


@router.get("/invoices")
def list_invoices(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    require_super(payload)
    from app.services.arca import _ensure_tables, is_configured
    _ensure_tables(db)
    rows = db.execute(text("""
        SELECT i.*, c.name AS company_name FROM invoices i
        LEFT JOIN companies c ON c.id = i.company_id
        ORDER BY i.id DESC LIMIT 200
    """)).mappings().all()
    return {"ok": True, "arca_configured": is_configured(), "invoices": [dict(r) for r in rows]}


@router.post("/arca/dummy")
def arca_dummy(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    require_super(payload)
    from app.services import arca
    try:
        status = arca.dummy()
        ta_ok = False
        if arca.is_configured():
            try:
                arca.get_ta(db)
                ta_ok = True
            except Exception as e:
                return {"ok": True, "dummy": status, "configured": True, "wsaa_ok": False, "wsaa_error": str(e)[:300]}
        return {"ok": True, "dummy": status, "configured": arca.is_configured(), "wsaa_ok": ta_ok, "env": (arca._env())}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}
