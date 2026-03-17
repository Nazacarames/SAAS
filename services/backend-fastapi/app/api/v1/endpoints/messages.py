import re
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload
from app.core.db import get_db
from app.schemas.messages import MessageOut, MessageSendRequest
from app.services.messages_service import (
    create_outbound_message,
    list_messages,
    list_messages_paginated,
)

router = APIRouter(prefix="/messages", tags=["messages"])

_VALID_IDEM_RE = re.compile(r"^[a-zA-Z0-9:_\-\.]+$")
_NORMALIZE_RE = re.compile(r"[^a-z0-9:_\-\.]")
_MAX_IDEM_LEN = 120
_RETRY_MAX = 1000


def _normalize_key(raw: str) -> str:
    return _NORMALIZE_RE.sub("", raw.lower())


def _resolve_idempotency(
    header_x: str | None,
    header_plain: str | None,
    body_key: str | None,
) -> str:
    """
    Resolve idempotency key from headers / body with Node-compatible validation:
    - validate chars + length
    - detect mismatch between header variants and body
    - normalize to lowercase
    - fallback: generate ui:<uuid>
    """
    sources: list[tuple[str, str]] = []  # (label, raw_value)

    if header_x:
        if len(header_x) > _MAX_IDEM_LEN:
            raise HTTPException(400, detail="idempotencyKey too long (max 120)")
        if not _VALID_IDEM_RE.match(header_x):
            raise HTTPException(400, detail="idempotencyKey contains invalid characters")
        sources.append(("x-idempotency-key", header_x))

    if header_plain:
        if len(header_plain) > _MAX_IDEM_LEN:
            raise HTTPException(400, detail="idempotencyKey too long (max 120)")
        if not _VALID_IDEM_RE.match(header_plain):
            raise HTTPException(400, detail="idempotencyKey contains invalid characters")
        sources.append(("idempotency-key", header_plain))

    if body_key:
        if len(body_key) > _MAX_IDEM_LEN:
            raise HTTPException(400, detail="idempotencyKey too long (max 120)")
        if not _VALID_IDEM_RE.match(body_key):
            raise HTTPException(400, detail="idempotencyKey contains invalid characters")
        sources.append(("body", body_key))

    # Check mismatch between header variants
    if len(sources) >= 2:
        normalized = [_normalize_key(v) for _, v in sources]
        if len(set(normalized)) > 1:
            raise HTTPException(400, detail="idempotencyKey mismatch between sources")

    if sources:
        return _normalize_key(sources[0][1])

    return f"ui:{uuid.uuid4()}"


def _resolve_retry(
    header_retry: str | None,
    header_count: str | None,
    body_retry: int | None,
) -> int | None:
    raw: str | None = None
    if body_retry is not None:
        raw = str(body_retry)
    elif header_retry:
        raw = header_retry
    elif header_count:
        raw = header_count

    if raw is None:
        return None

    try:
        val = int(raw)
    except (ValueError, TypeError):
        raise HTTPException(
            400,
            detail="retryAttempt invalid (allowed integer range: 1..1000)",
        )

    if val < 1 or val > _RETRY_MAX:
        raise HTTPException(
            400,
            detail=f"retryAttempt too high",
            headers={"x-retry-attempt-max-accepted": str(_RETRY_MAX)},
        )
    return val


# ── GET /api/messages/{conversation_id} ──────────────────────────


@router.get("/{conversation_id}")
def messages_list(
    conversation_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    page: int | None = Query(default=None, ge=1),
    limit: int | None = Query(default=None, ge=1, le=500),
):
    company_id = int(payload.get("companyId") or 0)

    # Paginated mode when page or limit provided
    if page is not None or limit is not None:
        return list_messages_paginated(
            db,
            company_id=company_id,
            contact_id=conversation_id,
            page=page or 1,
            limit=limit or 50,
        )

    # Legacy array mode
    return list_messages(db, company_id=company_id, contact_id=conversation_id, limit=200)


# ── POST /api/messages ───────────────────────────────────────────


@router.post("/", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
def messages_send(
    body: MessageSendRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    x_idempotency_key: str | None = Header(default=None, alias="x-idempotency-key"),
    idempotency_key_header: str | None = Header(default=None, alias="idempotency-key"),
    x_retry_attempt: str | None = Header(default=None, alias="x-retry-attempt"),
    x_retry_count: str | None = Header(default=None, alias="x-retry-count"),
):
    company_id = int(payload.get("companyId") or 0)
    user_id = int(payload.get("id") or 0)
    contact_id = int(body.contactId or body.conversationId or 0)
    if not contact_id:
        raise HTTPException(status_code=400, detail="contactId/conversationId required")

    # Resolve & validate idempotency key
    idem_key = _resolve_idempotency(x_idempotency_key, idempotency_key_header, body.idempotencyKey)

    # Resolve & validate retry
    retry = _resolve_retry(x_retry_attempt, x_retry_count, body.retryAttempt)
    if retry is not None and retry > 1 and idem_key.startswith("ui:"):
        raise HTTPException(
            400,
            detail="retryAttempt > 1 requires an explicit idempotencyKey for safe retries",
        )

    row = create_outbound_message(
        db,
        company_id=company_id,
        contact_id=contact_id,
        user_id=user_id,
        body=body.body,
    )
    if not row:
        raise HTTPException(status_code=404, detail="contact not found")
    return row
