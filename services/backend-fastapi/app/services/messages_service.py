import math

from sqlalchemy import text
from sqlalchemy.orm import Session

_MSG_COLS = 'm.id, m.body, m."fromMe", m."contactId"'
_MSG_FROM = (
    "FROM messages m "
    'JOIN contacts c ON c.id = m."contactId" '
    'WHERE m."contactId"=:contact_id AND c."companyId"=:company_id'
)


def list_messages(
    db: Session,
    *,
    company_id: int,
    contact_id: int,
    limit: int = 200,
):
    """Legacy array mode — plain list."""
    rows = db.execute(
        text(
            f"SELECT {_MSG_COLS} {_MSG_FROM} "
            'ORDER BY m."createdAt" ASC LIMIT :limit'
        ),
        {
            "contact_id": contact_id,
            "company_id": company_id,
            "limit": max(1, min(limit, 500)),
        },
    ).mappings().all()
    return [dict(r) for r in rows]


def list_messages_paginated(
    db: Session,
    *,
    company_id: int,
    contact_id: int,
    page: int = 1,
    limit: int = 50,
):
    """Paginated mode — {data, total, page, limit, totalPages}."""
    page = max(1, page)
    limit = max(1, min(limit, 200))  # Node caps at 200 for paginated
    offset = (page - 1) * limit

    base_params = {"contact_id": contact_id, "company_id": company_id}

    total_row = db.execute(
        text(f"SELECT COUNT(*) AS cnt {_MSG_FROM}"),
        base_params,
    ).mappings().first()
    total = int(total_row["cnt"]) if total_row else 0

    rows = db.execute(
        text(
            f"SELECT {_MSG_COLS} {_MSG_FROM} "
            'ORDER BY m."createdAt" ASC LIMIT :limit OFFSET :offset'
        ),
        {**base_params, "limit": limit, "offset": offset},
    ).mappings().all()

    return {
        "data": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "limit": limit,
        "totalPages": math.ceil(total / limit) if limit else 0,
    }


def create_outbound_message(
    db: Session,
    *,
    company_id: int,
    contact_id: int,
    user_id: int,
    body: str,
):
    exists = db.execute(
        text('SELECT id FROM contacts WHERE id=:id AND "companyId"=:company_id LIMIT 1'),
        {"id": contact_id, "company_id": company_id},
    ).mappings().first()
    if not exists:
        return None

    row = db.execute(
        text(
            'INSERT INTO messages (body, "fromMe", "contactId", "userId", "createdAt", "updatedAt") '
            'VALUES (:body, true, :contact_id, :user_id, NOW(), NOW()) '
            'RETURNING id, body, "fromMe", "contactId"'
        ),
        {"body": body, "contact_id": contact_id, "user_id": user_id},
    ).mappings().first()
    db.commit()
    return dict(row)


def get_conversation_messages(db: Session, contact_id: int, limit: int = 20):
    """Get recent messages for a contact (for AI context)"""
    rows = db.execute(
        text(
            'SELECT body, "fromMe", "createdAt" FROM messages '
            'WHERE "contactId" = :contact_id '
            'ORDER BY "createdAt" DESC LIMIT :limit'
        ),
        {"contact_id": contact_id, "limit": limit},
    ).mappings().all()
    return [{"body": r["body"], "fromMe": r["fromMe"], "createdAt": str(r["createdAt"])} for r in rows]
