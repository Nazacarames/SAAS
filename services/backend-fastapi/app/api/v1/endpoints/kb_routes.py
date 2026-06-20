"""Knowledge base (documents, chunks, RAG search) and orchestrator endpoint."""
import json
import math
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, get_db
from app.api.v1.endpoints._ai_shared import (
    KBDocumentCreate, KBDocumentUpdate, OrchestrateRequest,
)

router = APIRouter()


# ── KB Documents ──────────────────────────────────────────────────────

@router.get("/kb/documents")
def list_kb_documents(
    q: str = Query(""),
    category: str = Query(""),
    status: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    where_clauses = ["d.company_id = :companyId"]
    params = {"companyId": company_id}

    if q:
        where_clauses.append("(LOWER(d.title) LIKE LOWER(:q) OR LOWER(d.content) LIKE LOWER(:q))")
        params["q"] = f"%{q}%"
    if category:
        where_clauses.append("d.category = :category")
        params["category"] = category
    if status:
        where_clauses.append("d.status = :status")
        params["status"] = status

    rows = db.execute(
        text(f"""SELECT d.id, d.title, d.category, d.status, d.source_type, d.content,
                COALESCE(d.is_default, FALSE) AS is_default,
                COALESCE(d.needs_setup, FALSE) AS needs_setup,
                d.created_at, d.updated_at,
                COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
         FROM kb_documents d
         WHERE {' AND '.join(where_clauses)}
         ORDER BY COALESCE(d.is_default, FALSE) DESC, d.id ASC LIMIT 500"""),
        params,
    ).mappings().all()

    return [dict(row) for row in rows]


@router.post("/kb/documents", status_code=201)
def create_kb_document(
    body: KBDocumentCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    doc = db.execute(
        text("""INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
            VALUES (:companyId, :title, :category, 'manual', 'ready', :content, NOW(), NOW())
            RETURNING *"""),
        {"companyId": company_id, "title": body.title, "category": body.category, "content": body.content},
    ).mappings().first()

    parts = [p.strip() for p in re.split(r"\n{2,}", body.content) if p.strip()][:200]
    for i, part in enumerate(parts):
        db.execute(
            text("""INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
                VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())"""),
            {"documentId": doc["id"], "chunkIndex": i, "chunkText": part, "tokenCount": max(1, math.floor(len(part) / 4))},
        )

    db.commit()
    return {"document": dict(doc), "chunksCreated": len(parts)}


@router.put("/kb/documents/{doc_id}")
def update_kb_document(
    doc_id: int,
    body: KBDocumentUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    existing = db.execute(
        text("SELECT * FROM kb_documents WHERE id = :id AND company_id = :companyId LIMIT 1"),
        {"id": doc_id, "companyId": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="Documento no encontrado")

    next_title = body.title if isinstance(body.title, str) else existing["title"]
    next_category = body.category if isinstance(body.category, str) else existing["category"]
    next_content = body.content if isinstance(body.content, str) else existing["content"]

    db.execute(
        text("UPDATE kb_documents SET title = :title, category = :category, content = :content, needs_setup = FALSE, updated_at = NOW() WHERE id = :id AND company_id = :companyId"),
        {"id": doc_id, "companyId": company_id, "title": next_title, "category": next_category, "content": next_content},
    )

    db.execute(text("DELETE FROM kb_chunks WHERE document_id = :documentId"), {"documentId": doc_id})

    parts = [p.strip() for p in re.split(r"\n{2,}", next_content) if p.strip()][:200]
    for i, part in enumerate(parts):
        db.execute(
            text("""INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
                VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())"""),
            {"documentId": doc_id, "chunkIndex": i, "chunkText": part, "tokenCount": max(1, math.floor(len(part) / 4))},
        )

    updated = db.execute(
        text("""SELECT d.id, d.title, d.category, d.status, d.source_type, d.created_at, d.updated_at,
                COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
         FROM kb_documents d WHERE d.id = :id AND d.company_id = :companyId LIMIT 1"""),
        {"id": doc_id, "companyId": company_id},
    ).mappings().first()

    db.commit()
    return {"ok": True, "document": dict(updated) if updated else None, "chunksCreated": len(parts)}


@router.delete("/kb/documents/{doc_id}")
def delete_kb_document(
    doc_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")

    existing = db.execute(
        text("SELECT id FROM kb_documents WHERE id = :id AND company_id = :companyId LIMIT 1"),
        {"id": doc_id, "companyId": company_id},
    ).mappings().first()

    if not existing:
        raise HTTPException(status_code=404, detail="Documento no encontrado")

    db.execute(text("DELETE FROM kb_chunks WHERE document_id = :documentId"), {"documentId": doc_id})
    db.execute(text("DELETE FROM kb_documents WHERE id = :id AND company_id = :companyId"), {"id": doc_id, "companyId": company_id})
    db.commit()

    return {"ok": True, "deletedId": doc_id}


@router.get("/kb/stats")
def get_kb_stats(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    row = db.execute(
        text("""SELECT COUNT(*)::int AS total,
                    SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END)::int AS synced,
                    SUM(CASE WHEN status <> 'ready' THEN 1 ELSE 0 END)::int AS pending,
                    COUNT(DISTINCT category)::int AS categories
             FROM kb_documents WHERE company_id = :companyId"""),
        {"companyId": company_id},
    ).mappings().first()

    return dict(row) if row else {"total": 0, "synced": 0, "pending": 0, "categories": 0}


# ── RAG Search ────────────────────────────────────────────────────────

@router.post("/rag/search")
def rag_search(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    query = str(body.get("query", ""))
    limit = min(100, max(1, int(body.get("limit", 5))))

    rows = db.execute(
        text("""SELECT c.id, c.document_id, c.chunk_text, d.title, d.category,
                        (CASE WHEN POSITION(LOWER(:query) IN LOWER(c.chunk_text)) > 0 THEN 0.95 ELSE 0.50 END) AS score
                 FROM kb_chunks c
                 JOIN kb_documents d ON d.id = c.document_id
                 WHERE d.company_id = :companyId
                   AND (LOWER(c.chunk_text) LIKE LOWER(:qLike) OR LOWER(d.title) LIKE LOWER(:qLike))
                 ORDER BY score DESC, c.id DESC
                 LIMIT :limit"""),
        {"companyId": company_id, "query": query, "qLike": f"%{query}%", "limit": limit},
    ).mappings().all()

    # Cast Decimal -> float (PostgreSQL returns CASE result as Decimal)
    def _row(r):
        d = dict(r)
        if "score" in d and hasattr(d["score"], "__float__"):
            d["score"] = float(d["score"])
        return d

    clean_rows = [_row(r) for r in rows]

    db.execute(
        text("""INSERT INTO kb_search_logs (company_id, query, top_k, results_json, created_at, updated_at)
            VALUES (:companyId, :query, :topK, :resultsJson, NOW(), NOW())"""),
        {"companyId": company_id, "query": query, "topK": limit, "resultsJson": json.dumps(clean_rows)},
    )
    db.commit()

    return clean_rows


# ── Orchestrate ───────────────────────────────────────────────────────

@router.post("/orchestrate")
async def orchestrate(
    body: OrchestrateRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="companyId missing from token")

    from app.services.conversation_orchestrator import orchestrate_reply

    result = await orchestrate_reply(
        text=body.message,
        conversation_history=body.conversation_history,
        company_id=company_id,
        conversation_id=body.conversation_id,
        contact_id=body.contact_id,
        conversation_state=body.conversation_state,
    )

    return result
