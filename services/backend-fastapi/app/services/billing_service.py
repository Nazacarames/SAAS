import json
import logging
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.billing")


def increment_usage(db: Session, company_id: int, metric: str, amount: int = 1) -> None:
    period = datetime.now(timezone.utc).strftime("%Y-%m")
    db.execute(
        text(
            """INSERT INTO usage_counters (company_id, period_ym, metric_code, metric_value, updated_at)
               VALUES (:cid, :period, :metric, :amount, NOW())
               ON CONFLICT (company_id, period_ym, metric_code)
               DO UPDATE SET metric_value = usage_counters.metric_value + :amount, updated_at = NOW()"""
        ),
        {"cid": company_id, "period": period, "metric": metric, "amount": amount},
    )
    db.commit()


def get_usage_count(db: Session, company_id: int, metric: str) -> int:
    period = datetime.now(timezone.utc).strftime("%Y-%m")
    row = db.execute(
        text(
            "SELECT metric_value FROM usage_counters "
            "WHERE company_id = :cid AND period_ym = :period AND metric_code = :metric"
        ),
        {"cid": company_id, "period": period, "metric": metric},
    ).mappings().first()
    return int(row["metric_value"]) if row else 0


def get_company_limits(db: Session, company_id: int) -> dict:
    row = db.execute(
        text(
            """SELECT bp.limits_json, bp.code as plan_code, cs.status
               FROM company_subscriptions cs
               JOIN billing_plans bp ON bp.code = cs.plan_code
               WHERE cs.company_id = :cid
               LIMIT 1"""
        ),
        {"cid": company_id},
    ).mappings().first()

    if not row:
        return {"conversations": 500, "users": 2, "plan_code": "free", "status": "active"}

    try:
        limits = json.loads(row["limits_json"].replace("{", '{"').replace(":", '":').replace(",", ',"'))
    except (json.JSONDecodeError, AttributeError):
        limits = {"conversations": 1500, "users": 2}

    limits["plan_code"] = row["plan_code"]
    limits["status"] = row["status"]
    return limits


def check_conversation_limit(db: Session, company_id: int) -> tuple[bool, str]:
    limits = get_company_limits(db, company_id)
    max_convs = int(limits.get("conversations", 1500))
    current = get_usage_count(db, company_id, "conversations")

    if current >= max_convs:
        return False, f"Límite de {max_convs} conversaciones/mes alcanzado. Actualizá tu plan."
    return True, ""


def check_subscription_active(db: Session, company_id: int) -> tuple[bool, str]:
    row = db.execute(
        text(
            """SELECT s.status, s."trialEndsAt", s."currentPeriodEnd",
                      s."billingBypass", cs.status as billing_status
               FROM subscriptions s
               LEFT JOIN company_subscriptions cs ON cs.company_id = s."companyId"
               WHERE s."companyId" = :cid
               ORDER BY s.id DESC LIMIT 1"""
        ),
        {"cid": company_id},
    ).mappings().first()

    if not row:
        return True, ""

    if row.get("billingBypass"):
        return True, ""

    status = row["status"]
    if status == "active":
        return True, ""

    if status == "trialing":
        trial_end = row.get("trialEndsAt")
        if trial_end and trial_end < datetime.now(timezone.utc):
            return False, "Tu período de prueba terminó. Activá un plan para seguir usando el CRM."
        return True, ""

    if status in ("canceled", "expired", "past_due"):
        return False, "Tu suscripción no está activa. Contactá soporte o activá un plan."

    return True, ""
