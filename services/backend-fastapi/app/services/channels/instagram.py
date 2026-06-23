from __future__ import annotations

import logging
from typing import Optional

import httpx

from .base import ChannelAdapter, ContactProfile, InboundMessage, SendResult

log = logging.getLogger("app.channels.instagram")

GRAPH_VERSION = "v21.0"


class InstagramAdapter(ChannelAdapter):
    channel_type = "instagram"

    def parse_inbound(self, entry: dict) -> list[InboundMessage]:
        out: list[InboundMessage] = []
        ig_account_id = str(entry.get("id", ""))
        for event in entry.get("messaging", []):
            msg = event.get("message", {})
            if not msg:
                continue
            sender = event.get("sender", {}).get("id", "")
            if sender == ig_account_id:
                continue
            text = msg.get("text", "")
            attachments = msg.get("attachments", [])
            media_url = attachments[0].get("payload", {}).get("url") if attachments else None
            media_type = attachments[0].get("type") if attachments else None
            if not text and media_type:
                text = f"[{media_type} message]"
            out.append(InboundMessage(
                channel_type="instagram",
                external_id=ig_account_id,
                sender_id=sender,
                sender_kind="igsid",
                text=text or "[empty message]",
                media_url=media_url,
                media_type=media_type,
                provider_message_id=msg.get("mid", ""),
                timestamp=event.get("timestamp"),
                raw=event,
            ))
        return out

    async def send_text(self, config: dict, recipient: str, text: str) -> SendResult:
        return await _send(config, recipient, {"text": text})

    async def send_media(self, config: dict, recipient: str, media_url: str, caption: str | None = None) -> SendResult:
        attachment = {"type": "image", "payload": {"url": media_url, "is_reusable": True}}
        return await _send(config, recipient, {"attachment": attachment})

    async def fetch_profile(self, config: dict, recipient_id: str) -> ContactProfile:
        token = config.get("token", "")
        if not token:
            return ContactProfile()
        try:
            url = f"https://graph.facebook.com/{GRAPH_VERSION}/{recipient_id}"
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, params={"fields": "name,username,profile_pic", "access_token": token}, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                return ContactProfile(
                    name=data.get("name", ""),
                    username=data.get("username", ""),
                    profile_pic=data.get("profile_pic", ""),
                )
        except Exception as e:
            log.warning("ig fetch_profile err=%s", str(e)[:100])
        return ContactProfile()

    def recipient_id_of(self, contact: dict) -> str | None:
        return contact.get("igsid")


async def _send(config: dict, recipient: str, message: dict) -> SendResult:
    ig_id = config.get("phoneId") or config.get("external_id", "")
    token = config.get("token", "")
    if not ig_id or not token:
        return SendResult(ok=False, error="instagram_not_configured")

    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{ig_id}/messages"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {"recipient": {"id": recipient}, "message": message}

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code in (200, 201):
            data = resp.json()
            return SendResult(ok=True, message_id=data.get("message_id", ""))
        log.warning("ig_send_failed status=%s to=%s err=%s", resp.status_code, recipient[:8], resp.text[:200])
        return SendResult(ok=False, error=resp.text[:200], status_code=resp.status_code)
    except Exception as e:
        log.warning("ig_send_exception err=%s", str(e)[:200])
        return SendResult(ok=False, error=str(e)[:200])
