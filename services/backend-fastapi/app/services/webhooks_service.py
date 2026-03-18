"""
Webhooks service - Business logic for Webhooks
"""
from typing import List, Optional
from sqlalchemy import text
from sqlalchemy.orm import Session


WEBHOOK_COLS = 'id, name, url, event, active, description, "companyId", "createdAt", "updatedAt"'


def list_webhooks(db: Session, *, company_id: int) -> List[dict]:
    """List all webhooks for a company"""
    rows = db.execute(
        text(f'SELECT {WEBHOOK_COLS} FROM webhooks WHERE "companyId" = :company_id ORDER BY name'),
        {"company_id": company_id}
    ).mappings().all()
    return [dict(r) for r in rows]


def get_webhook(db: Session, *, company_id: int, webhook_id: int) -> Optional[dict]:
    """Get a single webhook by ID"""
    row = db.execute(
        text(f'SELECT {WEBHOOK_COLS} FROM webhooks WHERE id = :webhook_id AND "companyId" = :company_id'),
        {"webhook_id": webhook_id, "company_id": company_id}
    ).mappings().first()
    return dict(row) if row else None


def create_webhook(db: Session, *, company_id: int, name: str, url: str, event: str = "message.create", active: bool = True, description: str = None) -> dict:
    """Create a new webhook"""
    row = db.execute(
        text(
            'INSERT INTO webhooks (name, url, event, active, description, "companyId", "createdAt", "updatedAt") '
            'VALUES (:name, :url, :event, :active, :description, :company_id, NOW(), NOW()) '
            f'RETURNING {WEBHOOK_COLS}'
        ),
        {"name": name, "url": url, "event": event, "active": active, "description": description, "company_id": company_id}
    ).mappings().first()
    db.commit()
    return dict(row)


def update_webhook(db: Session, *, company_id: int, webhook_id: int, **kwargs) -> Optional[dict]:
    """Update a webhook"""
    existing = get_webhook(db, company_id=company_id, webhook_id=webhook_id)
    if not existing:
        return None
    
    # Filter out None values
    updates = {k: v for k, v in kwargs.items() if v is not None}
    
    if not updates:
        return existing
    
    set_clause = ', '.join([f'{k} = :{k}' for k in updates.keys()])
    set_clause += ', "updatedAt" = NOW()'
    
    row = db.execute(
        text(f'UPDATE webhooks SET {set_clause} WHERE id = :webhook_id AND "companyId" = :company_id RETURNING {WEBHOOK_COLS}'),
        {"webhook_id": webhook_id, "company_id": company_id, **updates}
    ).mappings().first()
    db.commit()
    return dict(row)


def delete_webhook(db: Session, *, company_id: int, webhook_id: int) -> bool:
    """Delete a webhook"""
    result = db.execute(
        text('DELETE FROM webhooks WHERE id = :webhook_id AND "companyId" = :company_id'),
        {"webhook_id": webhook_id, "company_id": company_id}
    )
    db.commit()
    return result.rowcount > 0
