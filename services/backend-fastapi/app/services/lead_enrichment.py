"""
Enriquecimiento de leads en CADA mensaje entrante.

Antes esto vivía solo dentro del orquestador de IA: si al cliente lo atendía
el Menú Bot (o quedaba en manos de un humano), el lead se quedaba con score 0,
fase "Nuevo ingreso" y sin descripción — justo los leads más calientes, que
son los que piden asesor.

Escribe: contacts.lead_score, leadStatus y needs (descripción legible).
"""
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.lead_enrichment")

# Lo que aporta cada acción del bot: elegir "hablar con un asesor" o una
# sucursal es intención mucho más fuerte que cualquier palabra suelta.
BOT_CHOICE_POINTS = {
    "asesor": 35,
    "sucursal": 30,
    "opcion": 12,
    "menu": 2,
}


def _classify_bot_choice(label: str) -> str:
    low = (label or "").lower()
    if any(k in low for k in ("asesor", "vendedor", "hablar con", "atenc")):
        return "asesor"
    if any(k in low for k in ("sucursal", "local", "servicio", "reparac", "taller")):
        return "sucursal"
    return "opcion" if label else "menu"


def enrich_inbound(db: Session, company_id: int, contact_id: int, msg_text: str,
                   bot_choice: str = "") -> None:
    """Actualiza score, fase y descripción del lead. Nunca rompe el webhook."""
    try:
        from app.api.v1.endpoints._ai_shared import (
            _score_from_text, _infer_lead_status_by_signals, score_signals,
        )

        row = db.execute(
            text('SELECT lead_score, "leadStatus", needs FROM contacts '
                 'WHERE id = :cid AND "companyId" = :co LIMIT 1'),
            {"cid": contact_id, "co": company_id},
        ).mappings().first()
        if not row:
            return

        cur_score = int(float(row.get("lead_score") or 0))
        cur_status = str(row.get("leadStatus") or "")

        new_score = _score_from_text(msg_text or "", cur_score)
        _, labels = score_signals(msg_text or "")

        # Acción del bot: suma fuerte y queda descripta
        if bot_choice:
            kind = _classify_bot_choice(bot_choice)
            new_score = min(100, new_score + BOT_CHOICE_POINTS.get(kind, 0))
            labels.append(f"eligió «{bot_choice[:40]}»")

        new_status = _infer_lead_status_by_signals(msg_text or "", new_score, cur_status)

        # Descripción acumulada y sin repetir: lo que el vendedor necesita leer
        # de un vistazo antes de agarrar la conversación
        prev = [p.strip() for p in str(row.get("needs") or "").split("·") if p.strip()]
        for lab in labels:
            if lab not in prev:
                prev.append(lab)
        needs = " · ".join(prev[-8:])[:900]

        db.execute(
            text('UPDATE contacts SET lead_score = :s, "leadStatus" = :st, needs = :n, '
                 '"updatedAt" = NOW() WHERE id = :cid AND "companyId" = :co'),
            {"s": new_score, "st": new_status, "n": needs, "cid": contact_id, "co": company_id},
        )
        db.commit()

        # Mover la tarjeta del pipeline para que la fase acompañe al score
        try:
            from app.services.conversation_orchestrator import _sync_stage_from_status
            _sync_stage_from_status(db, company_id, contact_id, new_status)
        except Exception:
            pass

        # Si califica y la empresa lo tiene activado, va a Tokko
        try:
            from app.services.tokko_leads import maybe_sync_qualified_lead
            maybe_sync_qualified_lead(db, company_id, contact_id)
        except Exception:
            pass
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        log.warning("enrich_inbound company=%s contact=%s: %s", company_id, contact_id, str(e)[:150])
