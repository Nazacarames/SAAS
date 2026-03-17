from pydantic import BaseModel


class ConversationUpdateRequest(BaseModel):
    status: str | None = None
    userId: int | None = None


class ConversationUpdateResponse(BaseModel):
    conversationId: int
    leadStatus: str | None = None
    assignedUserId: int | None = None


class ConversationOut(BaseModel):
    id: int
    contactName: str | None = None
    contactNumber: str | None = None
    leadStatus: str | None = None
    assignedUserId: int | None = None
    updatedAt: str | None = None


class PaginatedConversations(BaseModel):
    data: list[ConversationOut]
    total: int
    page: int
    limit: int
    totalPages: int
