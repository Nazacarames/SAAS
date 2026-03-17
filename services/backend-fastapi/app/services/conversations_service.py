import math

from sqlalchemy import text
from sqlalchemy.orm import Session

_CONV_COLS = (
    'c.id, c.name AS "contactName", c.number AS "contactNumber", '
    'c."leadStatus", c."assignedUserId", c."updatedAt"'
)


def _build_where(company_id: int, status: str | None, contact_id: int | None):
    where = ['c."companyId" = :company_id']
    params: dict = {"company_id": company_id}
    if status:
        where.append('c."leadStatus" = :status')
        params["status"] = status
    if contact_id:
        where.append("c.id = :contact_id")
        params["contact_id"] = contact_id
    return " AND ".join(where), params


def list_conversations(
    db: Session,
    *,
    company_id: int,
    status: str | None = None,
    contact_id: int | None = None,
    limit: int = 200,
):
    """Legacy mode — returns plain list (no pagination metadata)."""
    where_clause, params = _build_where(company_id, status, contact_id)
    params["limit"] = max(1, min(limit, 500))
    rows = db.execute(
        text(
            f"SELECT {_CONV_COLS} FROM contacts c "
            f'WHERE {where_clause} ORDER BY c."updatedAt" DESC NULLS LAST, c.id DESC LIMIT :limit'
        ),
        params,
    ).mappings().all()
    return [dict(r) for r in rows]


def list_conversations_paginated(
    db: Session,
    *,
    company_id: int,
    status: str | None = None,
    contact_id: int | None = None,
    page: int = 1,
    limit: int = 50,
):
    """Paginated mode — returns {data, total, page, limit, totalPages}."""
    where_clause, params = _build_where(company_id, status, contact_id)

    page = max(1, page)
    limit = max(1, min(limit, 500))
    offset = (page - 1) * limit

    total_row = db.execute(
        text(f"SELECT COUNT(*) AS cnt FROM contacts c WHERE {where_clause}"),
        params,
    ).mappings().first()
    total = int(total_row["cnt"]) if total_row else 0

    params["limit"] = limit
    params["offset"] = offset
    rows = db.execute(
        text(
            f"SELECT {_CONV_COLS} FROM contacts c "
            f'WHERE {where_clause} ORDER BY c."updatedAt" DESC NULLS LAST, c.id DESC '
            f"LIMIT :limit OFFSET :offset"
        ),
        params,
    ).mappings().all()

    return {
        "data": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "limit": limit,
        "totalPages": math.ceil(total / limit) if limit else 0,
    }


def update_conversation(
    db: Session,
    *,
    company_id: int,
    conversation_id: int,
    status: str | None,
    user_id: int | None,
):
    exists = db.execute(
        text('SELECT id FROM contacts WHERE id=:id AND "companyId"=:company_id LIMIT 1'),
        {"id": conversation_id, "company_id": company_id},
    ).mappings().first()
    if not exists:
        return None

    db.execute(
        text(
            'UPDATE contacts SET "leadStatus" = COALESCE(:lead_status, "leadStatus"), '
            '"assignedUserId" = COALESCE(:assigned_user_id, "assignedUserId"), "updatedAt"=NOW() '
            'WHERE id=:id AND "companyId"=:company_id'
        ),
        {
            "lead_status": status,
            "assigned_user_id": user_id,
            "id": conversation_id,
            "company_id": company_id,
        },
    )
    row = db.execute(
        text(
            'SELECT "leadStatus", "assignedUserId" FROM contacts '
            'WHERE id=:id AND "companyId"=:company_id LIMIT 1'
        ),
        {"id": conversation_id, "company_id": company_id},
    ).mappings().first()
    db.commit()
    out = dict(row)
    out["conversationId"] = conversation_id
    return out
