from pydantic import BaseModel
from datetime import datetime


class ContactCreateRequest(BaseModel):
    name: str
    number: str
    email: str | None = None
    whatsappId: int | None = None
    source: str | None = None
    leadStatus: str | None = None
    assignedUserId: int | None = None


class ContactUpdateRequest(BaseModel):
    name: str | None = None
    number: str | None = None
    email: str | None = None
    whatsappId: int | None = None
    source: str | None = None
    leadStatus: str | None = None
    assignedUserId: int | None = None
    inactivityMinutes: int | None = None
    inactivityWebhookId: int | None = None
    tags: list[int] | None = None
    progress_tags: list[str] | None = None
    business_type: str | None = None
    needs: str | None = None


class ContactOut(BaseModel):
    id: int
    name: str
    number: str
    email: str | None = None
    whatsappId: int | None = None
    source: str | None = None
    leadStatus: str | None = None
    assignedUserId: int | None = None
    companyId: int
    inactivityMinutes: int | None = None
    inactivityWebhookId: int | None = None
    createdAt: datetime | None = None
    updatedAt: datetime | None = None
    lead_score: float | None = None
    business_type: str | None = None
    needs: str | None = None
    progress_tags: list[str] | None = None
    lead_stage: str | None = None

    class Config:
        from_attributes = True
