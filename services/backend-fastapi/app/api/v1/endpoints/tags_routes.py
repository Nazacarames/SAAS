"""
Tags API - FastAPI implementation
"""
from typing import List
from sqlalchemy import text
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_user_payload
from app.core.db import get_db

router = APIRouter(tags=["tags"])

TAG_COLS = 'id, name, "companyId", color'


@router.get("/")
def list_tags(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    """List all tags for company"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    rows = db.execute(
        text(f'SELECT {TAG_COLS} FROM tags WHERE "companyId" = :company_id ORDER BY name'),
        {"company_id": company_id}
    ).mappings().all()
    return [dict(r) for r in rows]


@router.post("/")
def create_tag(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    """Create tags (bulk upsert)"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # TODO: implement bulk upsert
    return {"ok": True}


@router.put("/{tag_id}")
def update_tag(tag_id: int, payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    """Update a tag"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    return {"ok": True}


@router.delete("/{tag_id}")
def delete_tag(tag_id: int, payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    """Delete a tag"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    db.execute(text('DELETE FROM tags WHERE id = :id AND "companyId" = :company_id'), 
               {"id": tag_id, "company_id": company_id})
    db.commit()
    return {"ok": True}
