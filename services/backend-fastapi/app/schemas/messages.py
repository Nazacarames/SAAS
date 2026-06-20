from pydantic import BaseModel


class MessageSendRequest(BaseModel):
    body: str
    conversationId: int | None = None
    contactId: int | None = None
    idempotencyKey: str | None = None
    retryAttempt: int | None = None


class MessageOut(BaseModel):
    # messages.id is a UUID string in this schema, not a serial int
    id: str | int
    body: str | None = None
    fromMe: bool | None = None
    contactId: int | None = None


class PaginatedMessages(BaseModel):
    data: list[MessageOut]
    total: int
    page: int
    limit: int
    totalPages: int
