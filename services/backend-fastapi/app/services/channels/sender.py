from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .base import SendResult
from .registry import get_adapter, get_send_config, resolve_channel_by_id, get_primary_channel
from .whatsapp import get_whatsapp_config

log = logging.getLogger("app.channels.sender")


async def send_via_channel(
    db: Session,
    *,
    channel_id: int | None = None,
    company_id: int | None = None,
    contact: dict | None = None,
    recipient_id: str | None = None,
    text_body: str | None = None,
    media_url: str | None = None,
    media_caption: str | None = None,
) -> SendResult:
    channel = None
    if channel_id:
        channel = resolve_channel_by_id(db, channel_id)

    if not channel and contact:
        cid = contact.get("channel_id")
        if cid:
            channel = resolve_channel_by_id(db, cid)

    if not channel and company_id:
        channel = get_primary_channel(db, company_id, "whatsapp")

    if not channel:
        if company_id:
            wa_cfg = get_whatsapp_config(db, company_id)
            if wa_cfg and recipient_id:
                from .whatsapp import _send as wa_send
                if text_body:
                    r = await wa_send(wa_cfg, recipient_id, {"type": "text", "text": {"body": text_body}})
                elif media_url:
                    r = await wa_send(wa_cfg, recipient_id, {"type": "image", "image": {"link": media_url, "caption": (media_caption or "")[:1024]}})
                else:
                    return SendResult(ok=False, error="nothing_to_send")
                return r
        return SendResult(ok=False, error="no_channel_found")

    adapter = get_adapter(channel["channel_type"])
    if not adapter:
        return SendResult(ok=False, error=f"unknown_channel_type:{channel['channel_type']}")

    config = get_send_config(channel)

    if not recipient_id and contact:
        recipient_id = adapter.recipient_id_of(contact)

    if not recipient_id:
        return SendResult(ok=False, error="no_recipient")

    if text_body:
        return await adapter.send_text(config, recipient_id, text_body)
    elif media_url:
        return await adapter.send_media(config, recipient_id, media_url, media_caption)
    else:
        return SendResult(ok=False, error="nothing_to_send")
