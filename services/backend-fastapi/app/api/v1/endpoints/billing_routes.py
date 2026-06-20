import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.config import settings
from app.core.db import get_db
from app.services.billing_service import (
    get_company_limits,
    get_usage_count,
    increment_usage,
)

router = APIRouter(prefix="", tags=["billing"])
log = logging.getLogger("app.billing")

_billing_tables_ready = False


def _ensure_billing_tables(db: Session) -> None:
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
                mp_preference_id VARCHAR(255),
                mp_subscription_id VARCHAR(255),
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

    db.execute(
        text(
            """INSERT INTO billing_plans (code, name, monthly_price_usd, limits_json, features_json)
            VALUES
                ('starter', 'Starter', 29990, '{"conversations":1500,"users":2,"ai_replies":3000}', '["whatsapp","meta_leads"]'),
                ('pro', 'Pro', 49990, '{"conversations":6000,"users":5,"ai_replies":15000}', '["whatsapp","meta_leads","ai_rag","advanced_reports","appointments"]'),
                ('scale', 'Scale', 89990, '{"conversations":15000,"users":10,"ai_replies":50000}', '["whatsapp","meta_leads","ai_rag","advanced_reports","appointments","api_access"]')
            ON CONFLICT (code) DO UPDATE SET
                monthly_price_usd = EXCLUDED.monthly_price_usd,
                limits_json = EXCLUDED.limits_json,
                features_json = EXCLUDED.features_json,
                updated_at = NOW()"""
        )
    )

    db.commit()
    _billing_tables_ready = True


# ── Schemas ───────────────────────────────────────────────────────
class PlanOut(BaseModel):
    code: str
    name: str
    monthly_price_usd: float
    limits_json: str
    features_json: str


class UpdatePlanRequest(BaseModel):
    planCode: str


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
    _ensure_billing_tables(db)
    company_id = payload.get("companyId")
    limits = get_company_limits(db, company_id)

    convs = get_usage_count(db, company_id, "conversations")
    ai_replies = get_usage_count(db, company_id, "ai_replies")
    msgs_sent = get_usage_count(db, company_id, "messages_sent")

    sub_row = db.execute(
        text(
            """SELECT s.status, s."trialEndsAt", s."trialStartsAt",
                      s."currentPeriodStart", s."currentPeriodEnd", s."billingBypass"
               FROM subscriptions s
               WHERE s."companyId" = :cid
               ORDER BY s.id DESC LIMIT 1"""
        ),
        {"cid": company_id},
    ).mappings().first()

    sub_info = dict(sub_row) if sub_row else None

    return {
        "ok": True,
        "plan": limits,
        "usage": {
            "conversations": convs,
            "ai_replies": ai_replies,
            "messages_sent": msgs_sent,
        },
        "subscription": sub_info,
    }


# ── GET /api/billing/usage ───────────────────────────────────────
@router.get("/api/billing/usage")
def get_usage(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_billing_tables(db)
    company_id = payload.get("companyId")
    rows = db.execute(
        text(
            "SELECT metric_code, metric_value, updated_at FROM usage_counters "
            "WHERE company_id = :cid ORDER BY metric_code"
        ),
        {"cid": company_id},
    ).mappings().all()
    return {"ok": True, "usage": [dict(r) for r in rows]}


# ── PUT /api/billing/current ─────────────────────────────────────
@router.put("/api/billing/current")
def update_current_plan(
    body: UpdatePlanRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_billing_tables(db)
    company_id = payload.get("companyId")
    plan_code = body.planCode.strip().lower()

    plan_exists = db.execute(
        text("SELECT code FROM billing_plans WHERE code = :code AND active = true"),
        {"code": plan_code},
    ).mappings().first()

    if not plan_exists:
        raise HTTPException(status_code=400, detail="Plan inválido")

    db.execute(
        text(
            """INSERT INTO company_subscriptions (company_id, plan_code, status, updated_at)
               VALUES (:cid, :code, 'active', NOW())
               ON CONFLICT (company_id)
               DO UPDATE SET plan_code = EXCLUDED.plan_code, status = 'active', updated_at = NOW()"""
        ),
        {"cid": company_id, "code": plan_code},
    )
    db.commit()

    return {"ok": True, "plan_code": plan_code}


# ── POST /api/billing/checkout ────────────────────────────────────
@router.post("/api/billing/checkout")
def create_checkout(
    body: UpdatePlanRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_billing_tables(db)

    mp_token = getattr(settings, "mp_access_token", "") or ""
    if not mp_token:
        raise HTTPException(status_code=501, detail="MercadoPago no está configurado. Contactá soporte.")

    company_id = payload.get("companyId")
    plan_code = body.planCode.strip().lower()

    plan = db.execute(
        text("SELECT code, name, monthly_price_usd FROM billing_plans WHERE code = :code AND active = true"),
        {"code": plan_code},
    ).mappings().first()

    if not plan:
        raise HTTPException(status_code=400, detail="Plan inválido")

    import requests as http_requests

    preference = {
        "items": [
            {
                "title": f"LMTM CRM — Plan {plan['name']}",
                "quantity": 1,
                "unit_price": float(plan["monthly_price_usd"]),
                "currency_id": "ARS",
            }
        ],
        "back_urls": {
            "success": f"{settings.frontend_url}/billing?status=success",
            "failure": f"{settings.frontend_url}/billing?status=failure",
            "pending": f"{settings.frontend_url}/billing?status=pending",
        },
        "auto_return": "approved",
        "external_reference": f"company_{company_id}_plan_{plan_code}",
        "notification_url": f"{settings.frontend_url.replace('https://login.charlott.ai', 'https://api.charlott.ai')}/api/billing/mp-webhook",
    }

    resp = http_requests.post(
        "https://api.mercadopago.com/checkout/preferences",
        json=preference,
        headers={"Authorization": f"Bearer {mp_token}"},
        timeout=10,
    )

    if resp.status_code not in (200, 201):
        log.error("MercadoPago preference error: %s", resp.text)
        raise HTTPException(status_code=502, detail="Error al crear la preferencia de pago")

    data = resp.json()
    checkout_url = data.get("init_point", "")

    db.execute(
        text(
            """INSERT INTO company_subscriptions (company_id, plan_code, status, mp_preference_id, updated_at)
               VALUES (:cid, :code, 'pending_payment', :pref_id, NOW())
               ON CONFLICT (company_id)
               DO UPDATE SET plan_code = EXCLUDED.plan_code, status = 'pending_payment',
                             mp_preference_id = EXCLUDED.mp_preference_id, updated_at = NOW()"""
        ),
        {"cid": company_id, "code": plan_code, "pref_id": data.get("id", "")},
    )
    db.commit()

    return {"ok": True, "checkoutUrl": checkout_url}


# ── POST /api/billing/mp-webhook ──────────────────────────────────
@router.post("/api/billing/mp-webhook")
async def mp_webhook(request: Request, db: Session = Depends(get_db)):
    mp_token = getattr(settings, "mp_access_token", "") or ""
    if not mp_token:
        return {"ok": True}

    body = await request.json()
    log.info("MercadoPago webhook: %s", json.dumps(body)[:500])

    if body.get("type") != "payment":
        return {"ok": True}

    payment_id = body.get("data", {}).get("id")
    if not payment_id:
        return {"ok": True}

    import requests as http_requests

    resp = http_requests.get(
        f"https://api.mercadopago.com/v1/payments/{payment_id}",
        headers={"Authorization": f"Bearer {mp_token}"},
        timeout=10,
    )

    if resp.status_code != 200:
        log.error("MP payment fetch failed: %s", resp.text[:200])
        return {"ok": True}

    payment = resp.json()
    status = payment.get("status", "")
    ext_ref = payment.get("external_reference", "")

    if not ext_ref.startswith("company_"):
        return {"ok": True}

    parts = ext_ref.split("_")
    try:
        company_id = int(parts[1])
        plan_code = parts[3] if len(parts) > 3 else "pro"
    except (IndexError, ValueError):
        return {"ok": True}

    if status == "approved":
        db.execute(
            text(
                """UPDATE company_subscriptions SET status = 'active', updated_at = NOW()
                   WHERE company_id = :cid"""
            ),
            {"cid": company_id},
        )
        db.execute(
            text(
                """UPDATE subscriptions SET status = 'active', "updatedAt" = NOW()
                   WHERE "companyId" = :cid AND status IN ('trialing', 'pending_payment')"""
            ),
            {"cid": company_id},
        )
        db.commit()
        log.info("Payment approved for company %d, plan %s", company_id, plan_code)

    return {"ok": True}


# ── GET /api/billing/status (legacy compat) ───────────────────────
@router.get("/api/billing/status")
def billing_status_compat(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    return get_current_plan(payload, db)
