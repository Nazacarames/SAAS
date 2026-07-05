"""
Sync de leads calificados a Tokko Broker.

Regla de negocio: a Tokko solo van POTENCIALES CLIENTES, no curiosos.
Un lead califica cuando su conversación demostró intención real:
  - lead_score >= umbral (default 40; override por empresa en
    ai_agents.ai_config_json.tokko_min_score), o
  - leadStatus en warm / hot / customer.

El hook vive en el orchestrator: cada vez que la IA actualiza el score de
un contacto se llama maybe_sync_qualified_lead(). Idempotente vía el tag
'enviado_tokko' (mismo tag que audita GET /api/ai/tokko/audit).
"""
import json
import logging

import requests
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.tokko_leads")

DEFAULT_MIN_SCORE = 40
QUALIFIED_STATUSES = ("warm", "hot", "customer")


def _min_score(db: Session, company_id: int) -> int:
    try:
        row = db.execute(
            text("SELECT ai_config_json FROM ai_agents WHERE company_id = :cid AND is_active = true ORDER BY id DESC LIMIT 1"),
            {"cid": company_id},
        ).mappings().first()
        if row and row["ai_config_json"]:
            v = (json.loads(row["ai_config_json"]) or {}).get("tokko_min_score")
            if v is not None:
                return int(v)
    except Exception:
        pass
    return DEFAULT_MIN_SCORE


def is_qualified(contact: dict, min_score: int) -> bool:
    status = str(contact.get("leadStatus") or "").lower()
    score = float(contact.get("lead_score") or 0)
    return status in QUALIFIED_STATUSES or score >= min_score


def _already_sent(db: Session, contact_id: int) -> bool:
    row = db.execute(
        text("""SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct."tagId"
                WHERE ct."contactId" = :cid AND LOWER(t.name) = 'enviado_tokko' LIMIT 1"""),
        {"cid": contact_id},
    ).first()
    return bool(row)


def _tag_sent(db: Session, company_id: int, contact_id: int) -> None:
    tag = db.execute(
        text('SELECT id FROM tags WHERE "companyId" = :co AND LOWER(name) = \'enviado_tokko\' LIMIT 1'),
        {"co": company_id},
    ).mappings().first()
    if not tag:
        tag = db.execute(
            text('''INSERT INTO tags (name, color, "companyId", "createdAt", "updatedAt")
                    VALUES ('enviado_tokko', '#00B1EA', :co, NOW(), NOW()) RETURNING id'''),
            {"co": company_id},
        ).mappings().first()
    db.execute(
        text('''INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
                VALUES (:cid, :tid, NOW(), NOW()) ON CONFLICT ("contactId", "tagId") DO NOTHING'''),
        {"cid": contact_id, "tid": tag["id"]},
    )
    db.commit()


def maybe_sync_qualified_lead(db: Session, company_id: int, contact_id: int) -> dict:
    """Push the contact to Tokko webcontact IF it qualifies. Safe to call on
    every score update: exits cheap when not qualified / already sent /
    Tokko not configured. Never raises."""
    try:
        contact = db.execute(
            text('SELECT id, name, number, email, needs, lead_score, "leadStatus" FROM contacts WHERE id = :id AND "companyId" = :co LIMIT 1'),
            {"id": contact_id, "co": company_id},
        ).mappings().first()
        if not contact:
            return {"ok": False, "reason": "not_found"}

        min_score = _min_score(db, company_id)
        if not is_qualified(dict(contact), min_score):
            return {"ok": False, "reason": "not_qualified", "score": contact["lead_score"], "min": min_score}
        if _already_sent(db, contact_id):
            return {"ok": False, "reason": "already_sent"}

        # Solo la key Tokko PROPIA de la empresa — sin fallback a la key global
        # del .env (mandaría leads de una empresa al Tokko de otra).
        creds_row = db.execute(
            text("SELECT tokko_api_key, tokko_base_url FROM companies WHERE id = :cid LIMIT 1"),
            {"cid": company_id},
        ).mappings().first()
        if not creds_row or not creds_row.get("tokko_api_key"):
            return {"ok": False, "reason": "tokko_not_configured"}
        creds = {
            "api_url": (creds_row.get("tokko_base_url") or "https://www.tokkobroker.com/api/v1").rstrip("/"),
            "api_key": creds_row["tokko_api_key"],
        }

        needs = str(contact.get("needs") or "").strip()
        score = int(float(contact.get("lead_score") or 0))
        texto = f"Lead calificado por IA (score {score}/100)."
        if needs:
            texto += f" Búsqueda: {needs}"

        resp = requests.post(
            f"{creds['api_url'].rstrip('/')}/webcontact/?key={creds['api_key']}",
            json={
                "name": contact["name"] or "Lead LMTM CRM",
                "phone": str(contact["number"] or "").replace("+", "").replace(" ", ""),
                "email": contact.get("email") or "",
                "text": texto,
                "source": "LMTM CRM",
                "tags": ["Lead_Calificado", "Bot"],
            },
            headers={"Content-Type": "application/json"},
            timeout=15,
        )
        if resp.status_code in (200, 201):
            _tag_sent(db, company_id, contact_id)
            log.info("tokko lead synced company=%s contact=%s score=%s", company_id, contact_id, score)
            return {"ok": True, "score": score}

        db.execute(
            text("""INSERT INTO integration_errors (company_id, source, severity, error_code, message, suggestion, payload_json, created_at)
                    VALUES (:co, 'tokko', 'warning', :code, :msg, 'Revisar API key de Tokko', :pj, NOW())"""),
            {"co": company_id, "code": str(resp.status_code), "msg": f"webcontact falló: {resp.text[:200]}",
             "pj": json.dumps({"contact_id": contact_id})},
        )
        db.commit()
        return {"ok": False, "reason": "api_error", "status": resp.status_code}
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        log.error("tokko sync error company=%s contact=%s: %s", company_id, contact_id, e)
        return {"ok": False, "reason": "exception", "error": str(e)[:150]}
