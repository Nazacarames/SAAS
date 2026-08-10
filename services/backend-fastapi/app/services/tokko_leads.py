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


def _agent_cfg(db: Session, company_id: int) -> dict:
    try:
        row = db.execute(
            text("SELECT ai_config_json FROM ai_agents WHERE company_id = :cid AND is_active = true ORDER BY id DESC LIMIT 1"),
            {"cid": company_id},
        ).mappings().first()
        if row and row["ai_config_json"]:
            return json.loads(row["ai_config_json"]) or {}
    except Exception:
        pass
    return {}


def sync_enabled(db: Session, company_id: int) -> bool:
    """El envío de leads a Tokko lo decide el cliente en Configuración.

    Antes alcanzaba con tener cargada la API key: una empresa que la usaba solo
    para que el agente consultara propiedades empezaba a mandar leads sin
    haberlo pedido. Ahora manda el switch (companies.tokko_enabled +
    company_runtime_settings.tokkoSyncLeadsEnabled)."""
    try:
        if not db.execute(text("SELECT tokko_enabled FROM companies WHERE id = :c"), {"c": company_id}).scalar():
            return False
        raw = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :c"),
            {"c": company_id},
        ).scalar()
        s = json.loads(raw) if raw else {}
        return bool(s.get("tokkoSyncLeadsEnabled", True))  # default on si Tokko está activo
    except Exception:
        return False


def _conversation_summary(db: Session, company_id: int, contact_id: int, fallback: str) -> str:
    """Resumen corto de la charla para que el asesor no tenga que leerla entera.
    Se genera una sola vez (al calificar), no en cada mensaje."""
    try:
        from app.core.config import settings
        if not settings.openai_api_key:
            return fallback
        msgs = db.execute(
            text('SELECT body, "fromMe" FROM messages WHERE "contactId" = :cid ORDER BY id DESC LIMIT 20'),
            {"cid": contact_id},
        ).mappings().all()
        history = "\n".join(
            f"{'Empresa' if m['fromMe'] else 'Cliente'}: {str(m['body'])[:200]}"
            for m in reversed(msgs) if m["body"] and not str(m["body"]).startswith("[")
        )
        if not history.strip():
            return fallback
        from openai import OpenAI
        client = OpenAI(api_key=settings.openai_api_key, timeout=20.0, max_retries=1)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": (
                "Resumí en 2 oraciones qué necesita este cliente y en qué quedó la conversación. "
                "Escribí para un vendedor que va a llamarlo: concreto, sin saludos ni relleno.\n\n" + history)}],
            max_tokens=140,
            temperature=0.3,
        )
        txt = (resp.choices[0].message.content or "").strip().replace("\n", " ")
        return txt[:600] or fallback
    except Exception as e:
        log.warning("tokko summary company=%s contact=%s: %s", company_id, contact_id, str(e)[:100])
        return fallback


def _lead_tags(db: Session, contact: dict) -> list[str]:
    """Etiquetas que le sirven al vendedor en Tokko: origen, fase y quién atiende."""
    tags = ["LMTM CRM"]
    status = str(contact.get("leadStatus") or "").lower()
    tags.append({
        "cierre": "Cierre", "propuesta": "Propuesta", "calificacion": "Calificado",
        "hot": "Caliente", "warm": "Tibio", "customer": "Cliente",
    }.get(status, "Nuevo"))
    score = int(float(contact.get("lead_score") or 0))
    tags.append("Score alto" if score >= 70 else "Score medio" if score >= 40 else "Score bajo")
    src = str(contact.get("source") or "").lower()
    if src:
        tags.append({"whatsapp": "WhatsApp", "instagram": "Instagram", "messenger": "Messenger"}.get(src, src[:20]))
    if contact.get("assignedUserId"):
        name = db.execute(text("SELECT name FROM users WHERE id = :i"), {"i": contact["assignedUserId"]}).scalar()
        if name:
            tags.append(f"Asesor: {name}"[:40])
    return tags[:8]


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
        if not sync_enabled(db, company_id):
            return {"ok": False, "reason": "sync_disabled"}

        contact = db.execute(
            text('SELECT id, name, number, email, needs, lead_score, "leadStatus", source, '
                 '"assignedUserId" FROM contacts WHERE id = :id AND "companyId" = :co LIMIT 1'),
            {"id": contact_id, "co": company_id},
        ).mappings().first()
        if not contact:
            return {"ok": False, "reason": "not_found"}

        # Numeros de prueba: nunca salen al CRM del cliente. Una prueba interna
        # que termina como consulta en Tokko no se puede borrar despues (el
        # endpoint webcontact solo acepta POST), asi que se frena antes.
        _num = "".join(c for c in str(contact["number"] or "") if c.isdigit())
        if _num.startswith(("54900001", "54900007", "5490000")) or _num.startswith(("888000", "999000")):
            log.info("tokko: numero de prueba, no se sincroniza (%s)", _num)
            return {"ok": False, "reason": "numero_de_prueba"}

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
        resumen = _conversation_summary(db, company_id, contact_id, needs)
        texto = f"Lead calificado por LMTM CRM (score {score}/100)."
        if resumen:
            texto += f"\n\nResumen: {resumen}"
        if needs and needs != resumen:
            texto += f"\nSeñales detectadas: {needs}"

        resp = requests.post(
            f"{creds['api_url'].rstrip('/')}/webcontact/?key={creds['api_key']}",
            json={
                "name": contact["name"] or "Lead LMTM CRM",
                "phone": str(contact["number"] or "").replace("+", "").replace(" ", ""),
                "email": contact.get("email") or "",
                "text": texto,
                "source": "LMTM CRM",
                "tags": _lead_tags(db, dict(contact)),
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
