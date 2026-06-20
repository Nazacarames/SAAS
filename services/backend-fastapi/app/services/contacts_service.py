import re

from sqlalchemy import text
from sqlalchemy.orm import Session

_CONTACT_COLS = (
    'id, name, number, email, "whatsappId", source, "leadStatus", '
    '"assignedUserId", "companyId", "inactivityMinutes", "inactivityWebhookId", '
    '"createdAt", "updatedAt", '
    'lead_score, business_type, needs, progress_tags, '
    # Stage thresholds owned by the backend: the frontend renders lead_stage
    # as-is instead of re-deriving it from score thresholds client-side.
    "CASE WHEN COALESCE(lead_score, 0) >= 75 THEN 'interesado' "
    "WHEN COALESCE(lead_score, 0) >= 50 THEN 'calificado' "
    "WHEN COALESCE(lead_score, 0) >= 25 THEN 'contactado' "
    "ELSE 'nuevo' END AS lead_stage"
)


def list_contacts(
    db: Session,
    *,
    company_id: int,
    status: str | None = None,
    assigned_user_id: int | None = None,
    limit: int = 200,
):
    where = ['"companyId" = :company_id']
    params: dict = {"company_id": company_id, "limit": max(1, min(limit, 500))}

    if status:
        where.append('"leadStatus" = :status')
        params["status"] = status

    if assigned_user_id is not None:
        where.append('"assignedUserId" = :assigned_user_id')
        params["assigned_user_id"] = assigned_user_id

    where_clause = " AND ".join(where)
    rows = db.execute(
        text(
            f"SELECT {_CONTACT_COLS} "
            f"FROM contacts WHERE {where_clause} ORDER BY id DESC LIMIT :limit"
        ),
        params,
    ).mappings().all()
    return [dict(r) for r in rows]


def create_contact(db: Session, *, company_id: int, payload: dict):
    row = db.execute(
        text(
            'INSERT INTO contacts (name, number, email, "whatsappId", source, "leadStatus", '
            '"assignedUserId", "companyId", "createdAt", "updatedAt") '
            'VALUES (:name, :number, :email, :whatsappId, :source, :leadStatus, '
            ':assignedUserId, :companyId, NOW(), NOW()) '
            f"RETURNING {_CONTACT_COLS}"
        ),
        {
            "name": payload.get("name"),
            "number": payload.get("number"),
            "email": payload.get("email"),
            "whatsappId": payload.get("whatsappId"),
            "source": payload.get("source"),
            "leadStatus": payload.get("leadStatus"),
            "assignedUserId": payload.get("assignedUserId"),
            "companyId": company_id,
        },
    ).mappings().first()
    db.commit()
    return dict(row)


def get_contact(db: Session, *, company_id: int, contact_id: int):
    row = db.execute(
        text(
            f"SELECT {_CONTACT_COLS} FROM contacts "
            'WHERE id = :id AND "companyId" = :company_id LIMIT 1'
        ),
        {"id": contact_id, "company_id": company_id},
    ).mappings().first()
    return dict(row) if row else None


def get_contact_by_phone(db: Session, phone: str, company_id: int = None):
    """Find contact by phone number scoped to a specific company."""
    normalized = re.sub(r"\D", "", phone)
    if company_id:
        row = db.execute(
            text(
                f'SELECT {_CONTACT_COLS} FROM contacts '
                'WHERE "companyId" = :company_id '
                'AND REPLACE(REPLACE(REPLACE(REPLACE(number, \'+\', \'\'), \' \', \'\'), \'-\', \'\'), \'(\', \'\') LIKE :phone '
                'LIMIT 1'
            ),
            {"company_id": company_id, "phone": f"%{normalized}%"},
        ).mappings().first()
    else:
        # Fallback: no company_id known yet (should only happen on first message)
        row = db.execute(
            text(
                f"SELECT {_CONTACT_COLS} FROM contacts "
                "WHERE REPLACE(REPLACE(REPLACE(REPLACE(number, '+', ''), ' ', ''), '-', ''), '(', '') LIKE :phone "
                "LIMIT 1"
            ),
            {"phone": f"%{normalized}%"},
        ).mappings().first()
    return dict(row) if row else None


def update_contact(db: Session, *, company_id: int, contact_id: int, payload: dict):
    existing = get_contact(db, company_id=company_id, contact_id=contact_id)
    if not existing:
        return None

    # Sanitize number to digits only
    if "number" in payload and payload["number"] is not None:
        payload["number"] = re.sub(r"\D", "", payload["number"])

    # Build SET clause dynamically (only provided, non-None fields)
    allowed = {
        "name", "number", "email", "whatsappId", "source",
        "leadStatus", "assignedUserId", "inactivityMinutes", "inactivityWebhookId",
        "business_type", "needs", "progress_tags",
    }
    col_map = {
        "whatsappId": '"whatsappId"',
        "leadStatus": '"leadStatus"',
        "assignedUserId": '"assignedUserId"',
        "inactivityMinutes": '"inactivityMinutes"',
        "inactivityWebhookId": '"inactivityWebhookId"',
    }

    sets: list[str] = []
    params: dict = {"id": contact_id, "company_id": company_id}
    for key, val in payload.items():
        if key in allowed and val is not None:
            col = col_map.get(key, key)
            sets.append(f"{col} = :{key}")
            params[key] = val

    if not sets:
        return existing

    sets.append('"updatedAt" = NOW()')
    set_clause = ", ".join(sets)

    db.execute(
        text(
            f'UPDATE contacts SET {set_clause} WHERE id = :id AND "companyId" = :company_id'
        ),
        params,
    )

    # Handle progress_tags as direct TEXT[] update (bypasses ContactTag join table)
    if "progress_tags" in payload and payload["progress_tags"] is not None:
        tags_val = payload["progress_tags"]
        if isinstance(tags_val, list):
            from sqlalchemy import text as _text
            db.execute(
                _text("UPDATE contacts SET progress_tags = CAST(:pt AS TEXT[]), \"updatedAt\" = NOW() WHERE id = :id AND \"companyId\" = :company_id"),
                {"pt": [str(t) for t in tags_val], "id": contact_id, "company_id": company_id},
            )

    # Handle legacy tag IDs (integer list only)
    if "tags" in payload and payload["tags"] is not None:
        tag_list = payload["tags"]
        if isinstance(tag_list, list) and all(isinstance(t, int) for t in tag_list):
            _sync_tags(db, contact_id, tag_list)

    db.commit()
    return get_contact(db, company_id=company_id, contact_id=contact_id)


def _sync_tags(db: Session, contact_id: int, tag_ids: list[int]) -> None:
    """Replace all tags for a contact (many-to-many via ContactTag)."""
    db.execute(
        text('DELETE FROM "ContactTag" WHERE "contactId" = :cid'),
        {"cid": contact_id},
    )
    for tid in tag_ids:
        db.execute(
            text(
                'INSERT INTO "ContactTag" ("contactId", "tagId", "createdAt", "updatedAt") '
                "VALUES (:cid, :tid, NOW(), NOW()) ON CONFLICT DO NOTHING"
            ),
            {"cid": contact_id, "tid": tid},
        )


def delete_contact(db: Session, *, company_id: int, contact_id: int) -> bool:
    existing = get_contact(db, company_id=company_id, contact_id=contact_id)
    if not existing:
        return False

    # Clean up messages first to avoid FK constraint issues
    db.execute(
        text('DELETE FROM messages WHERE "contactId" = :id'),
        {"id": contact_id},
    )
    db.execute(
        text('DELETE FROM contacts WHERE id = :id AND "companyId" = :company_id'),
        {"id": contact_id, "company_id": company_id},
    )
    db.commit()
    return True


def mark_contact_read(db: Session, *, company_id: int, contact_id: int):
    existing = get_contact(db, company_id=company_id, contact_id=contact_id)
    if not existing:
        return None

    db.execute(
        text(
            'UPDATE contacts SET "leadStatus" = \'read\', "lastInteractionAt" = NOW(), '
            '"updatedAt" = NOW() WHERE id = :id AND "companyId" = :company_id'
        ),
        {"id": contact_id, "company_id": company_id},
    )
    db.commit()
    return get_contact(db, company_id=company_id, contact_id=contact_id)
