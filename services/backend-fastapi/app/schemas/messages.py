from pydantic import BaseModel


class MessageSendRequest(BaseModel):
    body: str
    conversationId: int | None = None
    contactId: int | None = None
    idempotencyKey: str | None = None
    retryAttempt: int | None = None


class MessageOut(BaseModel):
    id: int
    body: str | None = None
    fromMe: bool | None = None
    contactId: int | None = None


class PaginatedMessages(BaseModel):
    data: list[MessageOut]
    total: int
    page: int
    limit: int
    totalPages: int
