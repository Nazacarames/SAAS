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


class AssignedUserOut(BaseModel):
    id: int | None = None
    name: str | None = None


class ContactOut(BaseModel):
    id: int
    # nullables: los contactos de Instagram/Messenger no tienen numero de
    # telefono (Meta da un PSID), y el nombre puede no venir. Con estos campos
    # obligatorios la lista entera fallaba y el panel mostraba "Sin leads".
    name: str | None = None
    number: str | None = None
    email: str | None = None
    whatsappId: int | None = None
    source: str | None = None
    leadStatus: str | None = None
    assignedUserId: int | None = None
    # sin este campo el response_model descartaba el asignado que ya resuelve
    # contacts_service y el panel mostraba "Sin asignar" con el lead asignado
    assignedUser: AssignedUserOut | None = None
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
    ai_paused: bool | None = None
    origen: str | None = None
    origen_detalle: str | None = None
    campaign_name: str | None = None
    ad_name: str | None = None

    class Config:
        from_attributes = True
