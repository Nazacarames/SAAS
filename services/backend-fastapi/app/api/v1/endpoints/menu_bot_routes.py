"""Configuración del Menú Bot (flujo de bienvenida determinístico de WhatsApp)."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.db import get_db
from app.services.menu_bot import ensure_tables, invalidate_flow

router = APIRouter(prefix="/menu-bot", tags=["menu-bot"])


class FlowUpdate(BaseModel):
    flow: dict


class AiPausedUpdate(BaseModel):
    paused: bool


def _company_id(payload: dict) -> int:
    cid = payload.get("companyId")
    if not cid:
        raise HTTPException(status_code=401, detail="Sin empresa en el token")
    return int(cid)


def _validate_flow(db: Session, cid: int, flow: dict) -> dict:
    options = flow.get("options") or []
    if flow.get("enabled") and not options:
        raise HTTPException(status_code=400, detail="Agregá al menos una opción al menú")
    if len(options) > 10:
        raise HTTPException(status_code=400, detail="Máximo 10 opciones (límite de listas de WhatsApp)")

    valid_users = {int(r["id"]) for r in db.execute(
        text('SELECT id FROM users WHERE "companyId" = :cid'), {"cid": cid}).mappings().all()}
    valid_stages = {int(r["id"]) for r in db.execute(
        text("SELECT id FROM lead_stages WHERE company_id = :cid"), {"cid": cid}).mappings().all()}

    def _check_node(node: dict, where: str, label_max: int):
        label = str(node.get("label") or "").strip()
        if not label:
            raise HTTPException(status_code=400, detail=f"{where}: falta el texto del botón")
        if len(label) > label_max:
            raise HTTPException(status_code=400, detail=f"{where}: '{label[:24]}…' supera {label_max} caracteres (límite de WhatsApp)")
        if node.get("after") not in (None, "", "human", "ai"):
            raise HTTPException(status_code=400, detail=f"{where}: 'after' debe ser human o ai")
        for u in node.get("assign_users") or []:
            if int(u) not in valid_users:
                raise HTTPException(status_code=400, detail=f"{where}: usuario {u} no pertenece a la empresa")
        if node.get("stage_id") and int(node["stage_id"]) not in valid_stages:
            raise HTTPException(status_code=400, detail=f"{where}: etapa inválida")

    label_max = 20 if len(options) <= 3 else 24
    for i, opt in enumerate(options):
        _check_node(opt, f"Opción {i + 1}", label_max)
        sub = opt.get("submenu")
        if sub:
            items = sub.get("items") or []
            if not items:
                raise HTTPException(status_code=400, detail=f"Opción {i + 1}: el submenú no tiene ítems")
            if len(items) > 10:
                raise HTTPException(status_code=400, detail=f"Opción {i + 1}: máximo 10 ítems por lista de WhatsApp")
            for j, it in enumerate(items):
                _check_node(it, f"Opción {i + 1} › ítem {j + 1}", 24)
                if len(str(it.get("description") or "")) > 72:
                    raise HTTPException(status_code=400, detail=f"Opción {i + 1} › ítem {j + 1}: descripción supera 72 caracteres")

    if flow.get("no_match") not in (None, "", "ai", "menu"):
        raise HTTPException(status_code=400, detail="'no_match' debe ser ai o menu")
    flow["reopen_hours"] = max(1, min(720, int(flow.get("reopen_hours") or 24)))

    # Canales donde corre el bot (vacío = todos los de WhatsApp)
    valid_channels = {int(r["id"]) for r in db.execute(
        text("SELECT id FROM channels WHERE company_id = :cid AND channel_type = 'whatsapp'"),
        {"cid": cid}).mappings().all()}
    chans = []
    for c in (flow.get("channel_ids") or []):
        try:
            cid_int = int(c)
        except (TypeError, ValueError):
            continue
        if cid_int not in valid_channels:
            raise HTTPException(status_code=400, detail=f"El canal {c} no pertenece a la empresa")
        chans.append(cid_int)
    flow["channel_ids"] = chans
    return flow


@router.get("")
def get_menu_bot(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    cid = _company_id(payload)
    ensure_tables(db)
    raw = db.execute(text("SELECT flow_json FROM bot_flows WHERE company_id = :cid"), {"cid": cid}).scalar()
    flow = json.loads(raw) if raw else {}
    stats_rows = db.execute(
        text("SELECT event_key, COUNT(*) AS n FROM flow_events WHERE company_id = :cid GROUP BY event_key"),
        {"cid": cid},
    ).mappings().all()
    users = db.execute(
        text('SELECT id, name FROM users WHERE "companyId" = :cid ORDER BY name'), {"cid": cid}
    ).mappings().all()
    stages = db.execute(
        text("SELECT id, name FROM lead_stages WHERE company_id = :cid ORDER BY position"), {"cid": cid}
    ).mappings().all()
    wa_channels = db.execute(
        text("""SELECT id, name, external_id, status, config_json FROM channels
                WHERE company_id = :cid AND channel_type = 'whatsapp' ORDER BY id"""),
        {"cid": cid},
    ).mappings().all()

    def _label(ch) -> str:
        raw = ch["config_json"]
        cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
        return cfg.get("displayPhone") or ch["external_id"]

    return {
        "flow": flow,
        "stats": {r["event_key"]: int(r["n"]) for r in stats_rows},
        "users": [dict(u) for u in users],
        "stages": [dict(s) for s in stages],
        "has_whatsapp": any(c["status"] == "active" for c in wa_channels),
        "channels": [{"id": c["id"], "name": c["name"], "display": _label(c),
                      "status": c["status"]} for c in wa_channels],
    }


@router.put("")
def save_menu_bot(
    body: FlowUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    cid = _company_id(payload)
    ensure_tables(db)
    flow = _validate_flow(db, cid, dict(body.flow or {}))
    db.execute(
        text("""INSERT INTO bot_flows (company_id, flow_json, updated_at)
                VALUES (:cid, :f, NOW())
                ON CONFLICT (company_id) DO UPDATE SET flow_json = :f, updated_at = NOW()"""),
        {"cid": cid, "f": json.dumps(flow, ensure_ascii=False)},
    )
    db.commit()
    invalidate_flow(cid)
    return {"ok": True, "flow": flow}


@router.put("/ai-paused/{contact_id}")
def set_ai_paused(
    contact_id: int,
    body: AiPausedUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Pausar/reanudar el agente IA para un contacto (handoff manual)."""
    cid = _company_id(payload)
    ensure_tables(db)
    row = db.execute(
        text('UPDATE contacts SET ai_paused = :p, "updatedAt" = NOW() WHERE id = :id AND "companyId" = :cid RETURNING id'),
        {"p": body.paused, "id": contact_id, "cid": cid},
    ).mappings().first()
    db.commit()
    if not row:
        raise HTTPException(status_code=404, detail="Contacto no encontrado")
    return {"ok": True, "ai_paused": body.paused}
