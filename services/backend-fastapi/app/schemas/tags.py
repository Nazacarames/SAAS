"""
Tag schemas - Pydantic models for Tags API
"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class TagBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    color: str = Field(default="#3B82F6")


class TagCreate(TagBase):
    pass


class TagUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    color: Optional[str] = None


class TagOut(BaseModel):
    id: int
    name: str
    color: str
    companyId: int
    createdAt: datetime
    updatedAt: datetime

    model_config = {"from_attributes": True}
