import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db

router = APIRouter(prefix="/pipeline", tags=["pipeline"])
log = logging.getLogger("app.pipeline")

DEFAULT_STAGES = [
    ("Nuevo", "#4FC3F7", False),
    ("Contactado", "#E8A020", False),
    ("Calificado", "#A78BFA", False),
    ("Propuesta", "#FB923C", False),
    ("Cierre", "#34D399", True),
]


def _ensure_stages(db: Session, company_id: int) -> None:
    """Seed default stages for a company that has none yet."""
    row = db.execute(
        text("SELECT COUNT(*) AS n FROM lead_stages WHERE company_id = :cid"),
        {"cid": company_id},
    ).mappings().first()
    if row and row["n"] > 0:
        return
    for i, (name, color, is_won) in enumerate(DEFAULT_STAGES):
        db.execute(
            text(
                "INSERT INTO lead_stages (company_id, name, color, position, is_won) "
                "VALUES (:cid, :name, :color, :pos, :won)"
            ),
            {"cid": company_id, "name": name, "color": color, "pos": i, "won": is_won},
        )
    db.commit()


class StageCreate(BaseModel):
    name: str
    color: str = "#E8A020"
    is_won: bool = False


class StageUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    is_won: bool | None = None


class ReorderRequest(BaseModel):
    order: list[int]  # stage ids in desired order


class MoveLeadRequest(BaseModel):
    stage_id: int
    # solo se usan al pasar a una etapa ganada: es el monto de la venta que se
    # le informa al pixel de Meta
    value: float | None = None
    currency: str | None = None


# ── GET /pipeline/stages ──────────────────────────────────────────
@router.get("/stages")
def list_stages(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    _ensure_stages(db, company_id)
    rows = db.execute(
        text(
            "SELECT id, name, color, position, is_won FROM lead_stages "
            "WHERE company_id = :cid ORDER BY position, id"
        ),
        {"cid": company_id},
    ).mappings().all()
    return {"ok": True, "stages": [dict(r) for r in rows]}


# ── GET /pipeline/board ───────────────────────────────────────────
@router.get("/board")
def get_board(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    _ensure_stages(db, company_id)

    stages = db.execute(
        text(
            "SELECT id, name, color, position, is_won FROM lead_stages "
            "WHERE company_id = :cid ORDER BY position, id"
        ),
        {"cid": company_id},
    ).mappings().all()

    if not stages:
        return {"ok": True, "stages": []}

    first_stage_id = stages[0]["id"]

    leads = db.execute(
        text(
            """SELECT c.id, c.name, c.number, c.email, c.source, c.lead_score,
                      c.progress_tags, c.stage_id,
                      c."leadStatus" AS lead_status, c.channel_id,
                      ch.channel_type,
                      (SELECT m.body FROM messages m
                       JOIN tickets t ON t.id = m."ticketId"
                       WHERE t."contactId" = c.id
                       ORDER BY m."createdAt" DESC LIMIT 1) AS last_message,
                      c."updatedAt" AS updated_at
               FROM contacts c
               LEFT JOIN channels ch ON ch.id = c.channel_id
               WHERE c."companyId" = :cid
               ORDER BY c."updatedAt" DESC NULLS LAST
               LIMIT 1000"""
        ),
        {"cid": company_id},
    ).mappings().all()

    by_stage: dict[int, list] = {s["id"]: [] for s in stages}
    for lead in leads:
        sid = lead["stage_id"] or first_stage_id
        if sid not in by_stage:
            sid = first_stage_id
        by_stage[sid].append({
            "id": lead["id"],
            "name": lead["name"],
            "number": lead["number"],
            "email": lead["email"],
            "source": lead["source"],
            "channel_type": lead["channel_type"],
            "lead_score": lead["lead_score"],
            "last_message": lead["last_message"],
            "updated_at": lead["updated_at"].isoformat() if lead["updated_at"] else None,
        })

    result = []
    for s in stages:
        result.append({
            "id": s["id"],
            "name": s["name"],
            "color": s["color"],
            "position": s["position"],
            "is_won": s["is_won"],
            "leads": by_stage[s["id"]],
            "count": len(by_stage[s["id"]]),
        })
    return {"ok": True, "stages": result}


# ── POST /pipeline/stages ─────────────────────────────────────────
@router.post("/stages")
def create_stage(
    body: StageCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="El nombre es requerido")

    pos_row = db.execute(
        text("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM lead_stages WHERE company_id = :cid"),
        {"cid": company_id},
    ).mappings().first()
    next_pos = pos_row["next"] if pos_row else 0

    db.execute(
        text(
            "INSERT INTO lead_stages (company_id, name, color, position, is_won) "
            "VALUES (:cid, :name, :color, :pos, :won)"
        ),
        {"cid": company_id, "name": body.name.strip(), "color": body.color, "pos": next_pos, "won": body.is_won},
    )
    db.commit()
    return {"ok": True}


# ── PUT /pipeline/stages/{id} ─────────────────────────────────────
@router.put("/stages/{stage_id}")
def update_stage(
    stage_id: int,
    body: StageUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    st = db.execute(
        text("SELECT id FROM lead_stages WHERE id = :id AND company_id = :cid"),
        {"id": stage_id, "cid": company_id},
    ).mappings().first()
    if not st:
        raise HTTPException(status_code=404, detail="Etapa no encontrada")

    updates, params = [], {"id": stage_id}
    if body.name is not None and body.name.strip():
        updates.append("name = :name"); params["name"] = body.name.strip()
    if body.color is not None:
        updates.append("color = :color"); params["color"] = body.color
    if body.is_won is not None:
        updates.append("is_won = :won"); params["won"] = body.is_won
    if updates:
        updates.append("updated_at = NOW()")
        db.execute(text(f"UPDATE lead_stages SET {', '.join(updates)} WHERE id = :id"), params)
        db.commit()
    return {"ok": True}


# ── DELETE /pipeline/stages/{id} ──────────────────────────────────
@router.delete("/stages/{stage_id}")
def delete_stage(
    stage_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")

    count_row = db.execute(
        text("SELECT COUNT(*) AS n FROM lead_stages WHERE company_id = :cid"),
        {"cid": company_id},
    ).mappings().first()
    if count_row and count_row["n"] <= 1:
        raise HTTPException(status_code=400, detail="Debe quedar al menos una etapa")

    st = db.execute(
        text("SELECT id FROM lead_stages WHERE id = :id AND company_id = :cid"),
        {"id": stage_id, "cid": company_id},
    ).mappings().first()
    if not st:
        raise HTTPException(status_code=404, detail="Etapa no encontrada")

    # Reassign leads to the first remaining stage
    fallback = db.execute(
        text(
            "SELECT id FROM lead_stages WHERE company_id = :cid AND id != :id "
            "ORDER BY position, id LIMIT 1"
        ),
        {"cid": company_id, "id": stage_id},
    ).mappings().first()
    if fallback:
        db.execute(
            text("UPDATE contacts SET stage_id = :fb WHERE stage_id = :id"),
            {"fb": fallback["id"], "id": stage_id},
        )
    db.execute(text("DELETE FROM lead_stages WHERE id = :id"), {"id": stage_id})
    db.commit()
    return {"ok": True}


# ── PUT /pipeline/stages/reorder ──────────────────────────────────
@router.put("/reorder")
def reorder_stages(
    body: ReorderRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    company_id = payload.get("companyId")
    for pos, sid in enumerate(body.order):
        db.execute(
            text("UPDATE lead_stages SET position = :pos, updated_at = NOW() WHERE id = :id AND company_id = :cid"),
            {"pos": pos, "id": sid, "cid": company_id},
        )
    db.commit()
    return {"ok": True}


# ── GET /pipeline/conversions ─────────────────────────────────────
@router.get("/conversions")
def conversions_stats(
    dias: int = 30,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Ventas cerradas y estado del aviso al pixel: lo que muestra el panel."""
    from app.services import meta_pixel
    return meta_pixel.stats(db, payload.get("companyId"), max(1, min(dias, 365)))


# ── PUT /pipeline/leads/{contact_id}/stage ────────────────────────
@router.put("/leads/{contact_id}/stage")
def move_lead(
    contact_id: int,
    body: MoveLeadRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    # verify both contact and stage belong to the caller's company
    stage = db.execute(
        text("SELECT id, name, is_won FROM lead_stages WHERE id = :sid AND company_id = :cid"),
        {"sid": body.stage_id, "cid": company_id},
    ).mappings().first()
    if not stage:
        raise HTTPException(status_code=404, detail="Etapa no encontrada")

    # La etapa de la que viene decide si esto es una venta nueva: mover un lead
    # ya cerrado de un lado a otro no vuelve a contar la venta ni la reenvia.
    contact = db.execute(
        text('SELECT c.id, COALESCE(s.is_won, false) AS venia_ganado '
             'FROM contacts c LEFT JOIN lead_stages s ON s.id = c.stage_id '
             'WHERE c.id = :id AND c."companyId" = :cid'),
        {"id": contact_id, "cid": company_id},
    ).mappings().first()
    if not contact:
        raise HTTPException(status_code=404, detail="Lead no encontrado")

    db.execute(
        text('UPDATE contacts SET stage_id = :sid, "leadStatus" = :name, "updatedAt" = NOW() WHERE id = :id'),
        {"sid": body.stage_id, "name": stage["name"], "id": contact_id},
    )

    # Lead cerrado o pasado a un asesor: el agente no vuelve a meterse. Los
    # recordatorios de cita siguen saliendo igual (no miran ai_paused), que es
    # justo lo único que se quiere que llegue después del cierre.
    if stage["is_won"] or str(stage["name"] or "").strip().lower().startswith("asesor"):
        db.execute(
            text('UPDATE contacts SET ai_paused = true, "updatedAt" = NOW() WHERE id = :id'),
            {"id": contact_id},
        )
    db.commit()

    conversion = None
    if stage["is_won"] and not contact["venia_ganado"]:
        # Best effort: si Meta no contesta, la venta igual queda registrada y el
        # lead igual queda movido. Nunca se le devuelve un error al usuario por
        # esto.
        try:
            from app.services import meta_pixel
            conversion = meta_pixel.send_conversion(
                db, company_id, contact_id,
                stage_id=stage["id"], user_id=payload.get("id"),
                value=float(body.value or 0), currency=body.currency,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("pixel: no se pudo registrar la conversion (%s)", e)

    return {"ok": True, "conversion": conversion}
