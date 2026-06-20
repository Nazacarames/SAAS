import math

from sqlalchemy import text
from sqlalchemy.orm import Session

_MSG_COLS = (
    'm.id, m.body, m."fromMe", m."contactId", '
    'm."ticketId", m."createdAt", m."mediaType", m."mediaUrl"'
)
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
    idempotency_key: str | None = None,
):
    exists = db.execute(
        text('SELECT id FROM contacts WHERE id=:id AND "companyId"=:company_id LIMIT 1'),
        {"id": contact_id, "company_id": company_id},
    ).mappings().first()
    if not exists:
        return None

    # Idempotency: if this key was already processed, return the original row
    # instead of inserting a duplicate (safe retries from the UI / API clients).
    if idempotency_key:
        prior = db.execute(
            text(
                'SELECT id, body, "fromMe", "contactId" FROM messages '
                "WHERE idempotency_key = :ikey LIMIT 1"
            ),
            {"ikey": idempotency_key},
        ).mappings().first()
        if prior:
            return dict(prior)

    # NOTE: messages table has no "userId" column; sender attribution lives on
    # the ticket. user_id is accepted for API compatibility but not persisted.
    row = db.execute(
        text(
            'INSERT INTO messages (body, "fromMe", "contactId", idempotency_key, "createdAt", "updatedAt") '
            "VALUES (:body, true, :contact_id, :ikey, NOW(), NOW()) "
            "ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING "
            'RETURNING id, body, "fromMe", "contactId"'
        ),
        {"body": body, "contact_id": contact_id, "ikey": idempotency_key},
    ).mappings().first()
    db.commit()

    if row is None and idempotency_key:
        # Concurrent retry won the race — return the row it inserted
        prior = db.execute(
            text(
                'SELECT id, body, "fromMe", "contactId" FROM messages '
                "WHERE idempotency_key = :ikey LIMIT 1"
            ),
            {"ikey": idempotency_key},
        ).mappings().first()
        return dict(prior) if prior else None

    return dict(row) if row else None


def get_conversation_messages(db: Session, contact_id: int, limit: int = 20, company_id: int = None):
    """Get recent messages for a contact, scoped to company to prevent cross-tenant leakage.

    company_id is mandatory: without it a caller could read another tenant's
    conversation history just by passing a foreign contact_id.
    """
    if not company_id:
        raise ValueError("company_id is required (multi-tenant safety)")
    rows = db.execute(
        text(
            'SELECT m.body, m."fromMe", m."createdAt" FROM messages m '
            'JOIN contacts c ON c.id = m."contactId" '
            'WHERE m."contactId" = :contact_id AND c."companyId" = :company_id '
            'ORDER BY m."createdAt" DESC LIMIT :limit'
        ),
        {"contact_id": contact_id, "company_id": company_id, "limit": limit},
    ).mappings().all()
    return [{"body": r["body"], "fromMe": r["fromMe"], "createdAt": str(r["createdAt"])} for r in rows]
