"""
Webhook schemas - Pydantic models for Webhooks API
"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class WebhookBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    url: str = Field(..., min_length=1)
    event: str = Field(default="message.create")
    active: bool = Field(default=True)
    description: Optional[str] = None


class WebhookCreate(WebhookBase):
    pass


class WebhookUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    url: Optional[str] = None
    event: Optional[str] = None
    active: Optional[bool] = None
    description: Optional[str] = None


class WebhookOut(BaseModel):
    id: int
    name: str
    url: str
    event: str
    active: bool
    description: Optional[str]
    companyId: int
    createdAt: datetime
    updatedAt: datetime

    model_config = {"from_attributes": True}
