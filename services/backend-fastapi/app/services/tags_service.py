"""
Tags service - Business logic for Tags
"""
from typing import List, Optional
from sqlalchemy import text
from sqlalchemy.orm import Session


TAG_COLS = 'id, name, color, "companyId", "createdAt", "updatedAt"'


def list_tags(db: Session, *, company_id: int) -> List[dict]:
    """List all tags for a company"""
    rows = db.execute(
        text(f'SELECT {TAG_COLS} FROM tags WHERE "companyId" = :company_id ORDER BY name'),
        {"company_id": company_id}
    ).mappings().all()
    return [dict(r) for r in rows]


def get_tag(db: Session, *, company_id: int, tag_id: int) -> Optional[dict]:
    """Get a single tag by ID"""
    row = db.execute(
        text(f'SELECT {TAG_COLS} FROM tags WHERE id = :tag_id AND "companyId" = :company_id'),
        {"tag_id": tag_id, "company_id": company_id}
    ).mappings().first()
    return dict(row) if row else None


def create_tag(db: Session, *, company_id: int, name: str, color: str = "#3B82F6") -> dict:
    """Create a new tag"""
    row = db.execute(
        text(
            'INSERT INTO tags (name, color, "companyId", "createdAt", "updatedAt") '
            'VALUES (:name, :color, :company_id, NOW(), NOW()) '
            f'RETURNING {TAG_COLS}'
        ),
        {"name": name, "color": color, "company_id": company_id}
    ).mappings().first()
    db.commit()
    return dict(row)


def upsert_tags(db: Session, *, company_id: int, names: List[str]) -> List[dict]:
    """Create multiple tags (upsert) - returns existing or created"""
    tags = []
    for name in names[:30]:  # Max 30
        name = name.strip()
        if not name:
            continue
        # Try to find existing
        existing = db.execute(
            text('SELECT id, name, color, "companyId", "createdAt", "updatedAt" FROM tags WHERE name = :name AND "companyId" = :company_id'),
            {"name": name, "company_id": company_id}
        ).mappings().first()
        
        if existing:
            tags.append(dict(existing))
        else:
            # Create new
            row = db.execute(
                text(
                    'INSERT INTO tags (name, color, "companyId", "createdAt", "updatedAt") '
                    'VALUES (:name, :color, :company_id, NOW(), NOW()) '
                    f'RETURNING {TAG_COLS}'
                ),
                {"name": name, "color": "#3B82F6", "company_id": company_id}
            ).mappings().first()
            db.commit()
            tags.append(dict(row))
    
    return tags


def update_tag(db: Session, *, company_id: int, tag_id: int, name: str = None, color: str = None) -> Optional[dict]:
    """Update a tag"""
    existing = get_tag(db, company_id=company_id, tag_id=tag_id)
    if not existing:
        return None
    
    updates = {}
    if name is not None:
        updates["name"] = name
    if color is not None:
        updates["color"] = color
    
    if not updates:
        return existing
    
    set_clause = ', '.join([f'{k} = :{k}' for k in updates.keys()])
    set_clause += ', "updatedAt" = NOW()'
    
    row = db.execute(
        text(f'UPDATE tags SET {set_clause} WHERE id = :tag_id AND "companyId" = :company_id RETURNING {TAG_COLS}'),
        {"tag_id": tag_id, "company_id": company_id, **updates}
    ).mappings().first()
    db.commit()
    return dict(row)


def delete_tag(db: Session, *, company_id: int, tag_id: int) -> bool:
    """Delete a tag"""
    result = db.execute(
        text('DELETE FROM tags WHERE id = :tag_id AND "companyId" = :company_id'),
        {"tag_id": tag_id, "company_id": company_id}
    )
    db.commit()
    return result.rowcount > 0
