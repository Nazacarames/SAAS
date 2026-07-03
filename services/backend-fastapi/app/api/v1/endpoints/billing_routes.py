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

    # Prices in ARS (column name is legacy). 'setup' is a one-time install fee.
    # JSON passed as bind params: literal {"x":1} inside text() would be
    # parsed by SQLAlchemy as a :1 bind parameter.
    _plans_seed = [
        ("starter", "Starter", 45000,
         {"conversations": 1500, "users": 2, "ai_replies": 3000, "channels": 1},
         ["whatsapp", "meta_leads", "pipeline", "agenda"]),
        ("pro", "Pro", 85000,
         {"conversations": 6000, "users": 5, "ai_replies": 15000, "channels": 3},
         ["whatsapp", "instagram", "messenger", "meta_leads", "ai_rag", "geo_search", "advanced_reports", "appointments"]),
        ("agencia", "Agencia", 160000,
         {"conversations": 15000, "users": 10, "ai_replies": 50000, "channels": 99},
         ["whatsapp", "instagram", "messenger", "meta_leads", "ai_rag", "geo_search", "advanced_reports", "appointments", "api_access", "priority_support"]),
        ("setup", "Instalación asistida", 120000,
         {"one_time": True},
         ["conexion_meta", "conexion_tokko", "entrenamiento_agente", "migracion_contactos", "capacitacion"]),
        # Enterprise: a medida, sólo asignable desde el panel admin (hidden
        # lo excluye del checkout self-service). Precio/límites editables ahí.
        ("enterprise", "Enterprise", 0,
         {"conversations": 100000, "users": 50, "ai_replies": 500000, "channels": 99, "hidden": True},
         ["todo_incluido", "canales_ilimitados", "api_access", "priority_support", "onboarding_dedicado", "sla"]),
    ]
    # DO NOTHING: plans are editable from the super-admin panel; the seed must
    # never overwrite those edits on process start.
    for _code, _name, _price, _limits, _features in _plans_seed:
        db.execute(
            text(
                """INSERT INTO billing_plans (code, name, monthly_price_usd, limits_json, features_json)
                VALUES (:code, :name, :price, :limits, :features)
                ON CONFLICT (code) DO NOTHING"""
            ),
            {"code": _code, "name": _name, "price": _price,
             "limits": json.dumps(_limits), "features": json.dumps(_features)},
        )
    # 'scale' replaced by 'agencia'
    db.execute(text("UPDATE billing_plans SET active = false WHERE code = 'scale'"))
    db.execute(text("UPDATE company_subscriptions SET plan_code = 'agencia' WHERE plan_code = 'scale'"))

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
@router.get("/billing/plans")
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
    # hidden plans (e.g. enterprise) are admin-assigned only, not self-service
    plans = []
    for r in rows:
        try:
            if json.loads(r["limits_json"] or "{}").get("hidden"):
                continue
        except Exception:
            pass
        plans.append(dict(r))
    return {"ok": True, "plans": plans}


# ── GET /api/billing/current ──────────────────────────────────────
@router.get("/billing/current")
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
@router.get("/billing/usage")
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
@router.put("/billing/current")
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
@router.post("/billing/checkout")
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

    is_one_time = "one_time" in (plan.get("limits_json") or "")
    preference = {
        "items": [
            {
                "title": f"LMTM CRM — {plan['name']}" + ("" if is_one_time else " (mensual)"),
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
        "notification_url": f"{settings.frontend_url}/api/billing/mp-webhook",
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
@router.post("/billing/mp-webhook")
async def mp_webhook(request: Request, db: Session = Depends(get_db)):
    mp_token = getattr(settings, "mp_access_token", "") or ""
    if not mp_token:
        return {"ok": True}

    # Validate MercadoPago webhook signature (x-signature: ts=..,v1=..) when a
    # webhook secret is configured. Manifest: id:<data.id>;request-id:<x-req-id>;ts:<ts>;
    mp_secret = getattr(settings, "mp_webhook_secret", "") or ""
    if mp_secret:
        import hmac as _hmac, hashlib as _hashlib
        _sig_header = request.headers.get("x-signature", "")
        _req_id = request.headers.get("x-request-id", "")
        _parts = dict(p.split("=", 1) for p in _sig_header.split(",") if "=" in p)
        _ts = _parts.get("ts", "").strip()
        _v1 = _parts.get("v1", "").strip()
        _data_id = str(request.query_params.get("data.id") or "")
        _manifest = f"id:{_data_id};request-id:{_req_id};ts:{_ts};"
        _expected = _hmac.new(mp_secret.encode(), _manifest.encode(), _hashlib.sha256).hexdigest()
        if not (_v1 and _hmac.compare_digest(_expected, _v1)):
            raise HTTPException(status_code=401, detail="Invalid MercadoPago signature")

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
                """UPDATE company_subscriptions SET status = 'active',
                   period_start = NOW(), period_end = NOW() + INTERVAL '31 days', updated_at = NOW()
                   WHERE company_id = :cid"""
            ),
            {"cid": company_id},
        )
        db.execute(
            text(
                """UPDATE subscriptions SET status = 'active', "updatedAt" = NOW()
                   WHERE "companyId" = :cid AND status IN ('trialing', 'pending_payment', 'expired', 'past_due')"""
            ),
            {"cid": company_id},
        )
        db.commit()
        log.info("Payment approved for company %d, plan %s", company_id, plan_code)

        # Fresh payment → the cached "subscription expired" verdict is stale
        try:
            from app.services.cache import invalidate
            invalidate(f"sub_active:{company_id}")
        except Exception:
            pass

        # Factura electrónica ARCA (best-effort: nunca rompe el webhook)
        try:
            from app.services.arca import emit_invoice
            amount = float(payment.get("transaction_amount") or 0)
            if amount > 0:
                emit_invoice(
                    db, company_id, amount,
                    description=f"LMTM CRM — plan {plan_code}",
                    mp_payment_id=str(payment_id),
                )
        except Exception as e:
            log.error("ARCA post-payment invoice failed: %s", e)

    return {"ok": True}


# ── GET /api/billing/status (legacy compat) ───────────────────────
@router.get("/billing/status")
def billing_status_compat(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    return get_current_plan(payload, db)
