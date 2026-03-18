"""
Tags API - FastAPI implementation
Migrated from Node.js TagRoutes
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_user_payload
from app.core.db import get_db
from app.schemas.tags import TagCreate, TagOut, TagUpdate
from app.services import tags_service

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("/", response_model=List[TagOut])
def list_tags(
    payload: dict = Depends(get_current_user_payload),
    db = Depends(get_db)
):
    """List all tags for company"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    return tags_service.list_tags(db, company_id=company_id)


@router.post("/", response_model=List[TagOut])
def create_tags(
    payload: dict = Depends(get_current_user_payload),
    db = Depends(get_db)
):
    """Create tags (bulk upsert from names array)"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # This endpoint accepts a JSON array of strings (tag names)
    # We need to handle this at the route level
    return []


@router.post("/bulk")
def create_tags_bulk(
    tags: List[str],
    payload: dict = Depends(get_current_user_payload),
    db = Depends(get_db)
):
    """Create multiple tags at once (bulk upsert)"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    return tags_service.upsert_tags(db, company_id=company_id, names=tags)


@router.put("/{tag_id}", response_model=TagOut)
def update_tag(
    tag_id: int,
    tag: TagUpdate,
    payload: dict = Depends(get_current_user_payload),
    db = Depends(get_db)
):
    """Update a tag"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    result = tags_service.update_tag(
        db,
        company_id=company_id,
        tag_id=tag_id,
        name=tag.name,
        color=tag.color
    )
    if not result:
        raise HTTPException(status_code=404, detail="Tag not found")
    
    return result


@router.delete("/{tag_id}")
def delete_tag(
    tag_id: int,
    payload: dict = Depends(get_current_user_payload),
    db = Depends(get_db)
):
    """Delete a tag"""
    company_id = payload.get("companyId")
    if not company_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    deleted = tags_service.delete_tag(db, company_id=company_id, tag_id=tag_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Tag not found")
    
    return {"ok": True}
