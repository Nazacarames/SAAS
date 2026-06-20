"""
Training router: conversation rating, export, stats, and golden example management.

Endpoints:
  POST /api/training/rate/{conversation_id}  -- thumbs up/down + comment
  GET  /api/training/export-rated            -- download JSONL of rated conversations
  GET  /api/training/stats                   -- metrics: rated, exported, current model
  POST /api/training/golden                  -- add golden example via API
"""
import json
from io import StringIO
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin, get_db

router = APIRouter(prefix="/api/training", tags=["training"])

SYSTEM_PROMPT = "Sos Charlott, asesora inmobiliaria de Rosario, Argentina. Respondés en espanol rioplatense, de forma calida y directa."


# ── Rate conversation ─────────────────────────────────────────────────────────

class RateRequest(BaseModel):
    rating: int  # 1 = good, -1 = bad
    comment: Optional[str] = None


@router.post("/rate/{conversation_id}")
async def rate_conversation(
    conversation_id: int,
    body: RateRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user_payload),
):
    if body.rating not in (1, -1):
        raise HTTPException(400, "rating must be 1 (good) or -1 (bad)")

    result = db.execute(
        text("UPDATE ai_conversations SET rating = :r, rating_comment = :c WHERE id = :id"),
        {"r": body.rating, "c": body.comment, "id": conversation_id},
    )
    if result.rowcount == 0:
        raise HTTPException(404, f"Conversation {conversation_id} not found")
    db.commit()

    return {"ok": True, "conversation_id": conversation_id, "rating": body.rating}


# ── Export rated conversations ────────────────────────────────────────────────

def build_jsonl(db: Session, conversation_ids: list) -> str:
    buf = StringIO()

    for cid in conversation_ids:
        turns = db.execute(
            text("SELECT id, role, content FROM ai_turns WHERE conversation_id = :cid ORDER BY created_at, id"),
            {"cid": cid},
        ).fetchall()

        tcs_raw = db.execute(
            text("SELECT turn_id, tool_name, tool_args_json, tool_result_json FROM ai_tool_calls WHERE conversation_id = :cid ORDER BY created_at, id"),
            {"cid": cid},
        ).fetchall()

        tc_by_turn = {}
        for tc in tcs_raw:
            tc_by_turn.setdefault(tc.turn_id, []).append(tc)

        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for turn in turns:
            tid = turn.id
            role = turn.role
            content = turn.content or ""

            if role == "user":
                messages.append({"role": "user", "content": content})
            elif role == "assistant":
                turn_tcs = tc_by_turn.get(tid, [])
                if turn_tcs:
                    tc_payload = [
                        {
                            "id": f"call_{tid}_{j}",
                            "type": "function",
                            "function": {
                                "name": tc.tool_name,
                                "arguments": tc.tool_args_json if isinstance(tc.tool_args_json, str) else json.dumps(tc.tool_args_json or {}),
                            },
                        }
                        for j, tc in enumerate(turn_tcs)
                    ]
                    messages.append({"role": "assistant", "content": content or None, "tool_calls": tc_payload})
                    for j, tc in enumerate(turn_tcs):
                        messages.append({
                            "role": "tool",
                            "tool_call_id": f"call_{tid}_{j}",
                            "content": tc.tool_result_json if isinstance(tc.tool_result_json, str) else json.dumps(tc.tool_result_json or {}),
                        })
                elif content:
                    messages.append({"role": "assistant", "content": content})

        if len(messages) >= 3 and messages[-1]["role"] == "assistant":
            buf.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")

    return buf.getvalue()


@router.get("/export-rated")
async def export_rated_conversations(
    run_id: Optional[str] = None,
    db: Session = Depends(get_db),
    _user=Depends(require_admin),
):
    rows = db.execute(
        text("SELECT id FROM ai_conversations WHERE rating = 1 AND (exported_for_training = FALSE OR exported_for_training IS NULL) ORDER BY created_at"),
    ).fetchall()
    cids = [r.id for r in rows]

    if not cids:
        return Response(content="", media_type="application/x-ndjson",
                        headers={"X-Export-Count": "0"})

    jsonl = build_jsonl(db, cids)

    export_run = run_id or f"export_{len(cids)}"
    db.execute(
        text("UPDATE ai_conversations SET exported_for_training = TRUE, export_run_id = :rid WHERE id = ANY(:ids)"),
        {"rid": export_run, "ids": cids},
    )
    db.commit()

    return Response(
        content=jsonl,
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": "attachment; filename=training_rated.jsonl",
            "X-Export-Count": str(len(cids)),
        },
    )


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def training_stats(
    db: Session = Depends(get_db),
    _user=Depends(get_current_user_payload),
):
    stats = db.execute(text("""
        SELECT
          COUNT(*) FILTER (WHERE rating IS NOT NULL) AS total_rated,
          COUNT(*) FILTER (WHERE rating = 1) AS positive,
          COUNT(*) FILTER (WHERE rating = -1) AS negative,
          COUNT(*) FILTER (WHERE exported_for_training = TRUE) AS exported,
          COUNT(*) FILTER (WHERE rating = 1 AND (exported_for_training = FALSE OR exported_for_training IS NULL)) AS pending_export
        FROM ai_conversations
    """)).fetchone()

    agent = db.execute(text("SELECT model, base_model FROM ai_agents LIMIT 1")).fetchone()
    golden = db.execute(text("SELECT COUNT(*) AS total FROM ai_training_golden WHERE active = TRUE")).fetchone()

    return {
        "conversations": {
            "total_rated": stats.total_rated,
            "positive": stats.positive,
            "negative": stats.negative,
            "exported": stats.exported,
            "pending_export": stats.pending_export,
        },
        "current_model": agent.model if agent else "unknown",
        "base_model": agent.base_model if agent else "gpt-4o-mini",
        "is_fine_tuned": (agent.model or "").startswith("ft:") if agent else False,
        "golden_examples": golden.total if golden else 0,
    }


# ── Add golden example ────────────────────────────────────────────────────────

class GoldenExampleRequest(BaseModel):
    title: str
    messages: list
    weight: int = 1


@router.post("/golden")
async def add_golden_example(
    body: GoldenExampleRequest,
    db: Session = Depends(get_db),
    _user=Depends(require_admin),
):
    if not body.messages or not body.title:
        raise HTTPException(400, "title and messages are required")

    row = db.execute(
        text("INSERT INTO ai_training_golden (title, messages, weight) VALUES (:t, :m, :w) RETURNING id"),
        {"t": body.title, "m": json.dumps(body.messages), "w": body.weight},
    ).fetchone()
    db.commit()

    return {"ok": True, "id": row.id}
