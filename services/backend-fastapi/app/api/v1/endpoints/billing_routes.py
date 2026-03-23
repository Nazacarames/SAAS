from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db

router = APIRouter(prefix="", tags=["billing"])


# ── In-memory flag for billing tables initialization ─────────────
_billing_tables_ready = False


def _ensure_billing_tables(db: Session) -> None:
    """Create billing tables if they don't exist."""
    global _billing_tables_ready
    if _billing_tables_ready:
        return

    db.execute(
        text(
            """CREATE TABLE IF NOT EXISTS billing_plans (
                code VARCHAR(30) PRIMARY KEY,
                name VARCHAR(60) NOT NULL,
                monthly_price_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
                limits_json TEXT NOT NULL DEFAULT '{}',
                features_json TEXT NOT NULL DEFAULT '[]',
                active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )"""
        )
    )

    db.execute(
        text(
            """CREATE TABLE IF NOT EXISTS company_subscriptions (
                company_id INTEGER PRIMARY KEY,
                plan_code VARCHAR(30) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                period_start TIMESTAMP NOT NULL DEFAULT NOW(),
                period_end TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )"""
        )
    )

    db.execute(
        text(
            """CREATE TABLE IF NOT EXISTS usage_counters (
                company_id INTEGER NOT NULL,
                period_ym VARCHAR(7) NOT NULL,
                metric_code VARCHAR(40) NOT NULL,
                metric_value BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (company_id, period_ym, metric_code)
            )"""
        )
    )

    # Insert default plans if not exist
    db.execute(
        text(
            """INSERT INTO billing_plans (code, name, monthly_price_usd, limits_json, features_json)
            VALUES
                ('starter', 'Starter', 129, '{"conversations":1500,"users":2}', '["integrations_api","meta_leads"]'),
                ('pro', 'Pro', 229, '{"conversations":6000,"users":5}', '["integrations_api","meta_leads","ai_rag","advanced_reports"]'),
                ('scale', 'Scale', 399, '{"conversations":15000,"users":10}', '["integrations_api","meta_leads","ai_rag","advanced_reports"]')
            ON CONFLICT (code) DO NOTHING"""
        )
    )

    db.commit()
    _billing_tables_ready = True


def _get_company_plan(db: Session, company_id: int) -> Optional[dict]:
    """Get the current plan for a company, creating a default if needed."""
    _ensure_billing_tables(db)

    row = db.execute(
        text(
            """SELECT cs.company_id, cs.plan_code, cs.status,
                      bp.name, bp.monthly_price_usd, bp.limits_json, bp.features_json
               FROM company_subscriptions cs
               JOIN billing_plans bp ON bp.code = cs.plan_code
               WHERE cs.company_id = :company_id
               LIMIT 1"""
        ),
        {"company_id": company_id},
    ).mappings().first()

    if row:
        return dict(row)

    # Create default starter subscription
    db.execute(
        text(
            """INSERT INTO company_subscriptions (company_id, plan_code, status)
               VALUES (:company_id, 'starter', 'active')
               ON CONFLICT (company_id) DO NOTHING"""
        ),
        {"company_id": company_id},
    )
    db.commit()

    row = db.execute(
        text(
            """SELECT cs.company_id, cs.plan_code, cs.status,
                      bp.name, bp.monthly_price_usd, bp.limits_json, bp.features_json
               FROM company_subscriptions cs
               JOIN billing_plans bp ON bp.code = cs.plan_code
               WHERE cs.company_id = :company_id
               LIMIT 1"""
        ),
        {"company_id": company_id},
    ).mappings().first()

    return dict(row) if row else None


# ── Schemas ───────────────────────────────────────────────────────
class PlanOut(BaseModel):
    code: str
    name: str
    monthly_price_usd: float
    limits_json: str
    features_json: str
    active: bool


class CurrentPlanOut(BaseModel):
    company_id: int
    plan_code: str
    status: str
    name: str
    monthly_price_usd: float
    limits_json: str
    features_json: str


class UsageRow(BaseModel):
    metric_code: str
    metric_value: int
    updated_at: datetime


# ── GET /api/billing/plans ────────────────────────────────────────
@router.get("/api/billing/plans")
def list_plans(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_billing_tables(db)
    rows = db.execute(
        text(
            """SELECT code, name, monthly_price_usd, limits_json, features_json, active
               FROM billing_plans WHERE active = true
               ORDER BY monthly_price_usd ASC"""
        )
    ).mappings().all()
    return {"ok": True, "plans": [dict(row) for row in rows]}


# ── GET /api/billing/current ──────────────────────────────────────
@router.get("/api/billing/current")
def get_current_plan(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    plan = _get_company_plan(db, company_id)
    if not plan:
        raise HTTPException(status_code=404, detail="No se encontró plan para esta empresa")
    return {"ok": True, "plan": plan}


# ── GET /api/billing/usage ───────────────────────────────────────
@router.get("/api/billing/usage")
def get_usage(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_billing_tables(db)
    company_id = payload.get("companyId")

    # Get period from query or current month
    # Note: Using a default period - in production you'd parse from query param

    rows = db.execute(
        text(
            """SELECT metric_code, metric_value, updated_at
               FROM usage_counters
               WHERE company_id = :company_id
               ORDER BY metric_code"""
        ),
        {"company_id": company_id},
    ).mappings().all()

    return {"ok": True, "period": None, "usage": [dict(row) for row in rows]}


# ── PUT /api/billing/current ─────────────────────────────────────
class UpdatePlanRequest(BaseModel):
    planCode: str


@router.put("/api/billing/current")
def update_current_plan(
    body: UpdatePlanRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    # Only admins can change plan
    require_admin(payload)

    _ensure_billing_tables(db)
    company_id = payload.get("companyId")
    plan_code = body.planCode.strip().lower()

    if not plan_code:
        raise HTTPException(status_code=400, detail="planCode es requerido")

    # Verify plan exists
    plan_exists = db.execute(
        text("SELECT code FROM billing_plans WHERE code = :code AND active = true"),
        {"code": plan_code},
    ).mappings().first()

    if not plan_exists:
        raise HTTPException(status_code=400, detail="Plan inválido")

    # Upsert subscription
    db.execute(
        text(
            """INSERT INTO company_subscriptions (company_id, plan_code, status, updated_at)
               VALUES (:company_id, :plan_code, 'active', NOW())
               ON CONFLICT (company_id)
               DO UPDATE SET plan_code = EXCLUDED.plan_code, status = 'active', updated_at = NOW()"""
        ),
        {"company_id": company_id, "plan_code": plan_code},
    )
    db.commit()

    plan = _get_company_plan(db, company_id)
    return {"ok": True, "plan": plan}
