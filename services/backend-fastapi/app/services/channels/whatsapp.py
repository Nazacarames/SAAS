from __future__ import annotations

import json
import logging
from typing import Optional

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from .base import ChannelAdapter, ContactProfile, InboundMessage, SendResult

log = logging.getLogger("app.channels.whatsapp")

GRAPH_VERSION = "v21.0"


class WhatsAppAdapter(ChannelAdapter):
    channel_type = "whatsapp"

    def parse_inbound(self, entry: dict) -> list[InboundMessage]:
        out: list[InboundMessage] = []
        for change in entry.get("changes", []):
            value = change.get("value", {})
            if value.get("statuses") and not value.get("messages"):
                continue
            phone_number_id = value.get("metadata", {}).get("phone_number_id", "")
            for msg in value.get("messages", []):
                text_body = msg.get("text", {}).get("body", "")
                if not text_body:
                    msg_type = msg.get("type", "unknown")
                    text_body = f"[{msg_type} message]"
                out.append(InboundMessage(
                    channel_type="whatsapp",
                    external_id=phone_number_id,
                    sender_id=msg.get("from", ""),
                    sender_kind="phone",
                    text=text_body,
                    provider_message_id=msg.get("id", ""),
                    timestamp=int(msg.get("timestamp", 0)) if msg.get("timestamp") else None,
                    raw=msg,
                ))
        return out

    async def send_text(self, config: dict, recipient: str, text: str) -> SendResult:
        return await _send(config, recipient, {"type": "text", "text": {"body": text}})

    async def send_media(self, config: dict, recipient: str, media_url: str, caption: str | None = None) -> SendResult:
        payload = {
            "type": "image",
            "image": {"link": media_url, "caption": (caption or "")[:1024]},
        }
        return await _send(config, recipient, payload)

    async def fetch_profile(self, config: dict, recipient_id: str) -> ContactProfile:
        return ContactProfile(name=recipient_id)

    def recipient_id_of(self, contact: dict) -> str | None:
        return contact.get("number")


def get_whatsapp_config(db: Session, company_id: int) -> Optional[dict]:
    row = db.execute(
        text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
        {"cid": company_id},
    ).mappings().first()
    if not row:
        return None
    settings = json.loads(row["settings_json"]) if isinstance(row["settings_json"], str) else row["settings_json"]
    phone_id = settings.get("waCloudPhoneNumberId")
    access_token = settings.get("waCloudAccessToken")
    if not phone_id or not access_token:
        return None
    return {"phoneId": phone_id, "token": access_token}


def get_channel_config(db: Session, channel_id: int) -> Optional[dict]:
    row = db.execute(
        text(
            """SELECT c.external_id, c.config_json,
                      mc.access_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.id = :cid"""
        ),
        {"cid": channel_id},
    ).mappings().first()
    if not row:
        return None
    cfg = json.loads(row["config_json"]) if isinstance(row["config_json"], str) else {}
    token = row.get("access_token") or cfg.get("waCloudAccessToken") or ""
    phone_id = row["external_id"]
    if not phone_id or not token:
        return None
    return {"phoneId": phone_id, "token": token}


async def _send(config: dict, phone: str, extra_payload: dict) -> SendResult:
    phone_id = config.get("phoneId")
    access_token = config.get("token")
    if not phone_id or not access_token:
        return SendResult(ok=False, error="whatsapp_not_configured")

    phone = phone.strip().replace("+", "")
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_id}/messages"
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    payload = {"messaging_product": "whatsapp", "to": phone, **extra_payload}

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code in (200, 201):
            data = resp.json()
            return SendResult(ok=True, message_id=data.get("messages", [{}])[0].get("id", ""))

        if resp.status_code not in (200, 201) and phone.startswith("549") and len(phone) == 13:
            payload["to"] = "54" + phone[3:]
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, headers=headers, timeout=30)
            if resp.status_code in (200, 201):
                data = resp.json()
                return SendResult(ok=True, message_id=data.get("messages", [{}])[0].get("id", ""))

        log.warning("wa_send_failed status=%s to=%s err=%s", resp.status_code, phone[:6], resp.text[:200])
        return SendResult(ok=False, error=resp.text[:200], status_code=resp.status_code)
    except Exception as e:
        log.warning("wa_send_exception err=%s", str(e)[:200])
        return SendResult(ok=False, error=str(e)[:200])


async def send_whatsapp_message(phone: str, text: str, config: dict) -> dict:
    r = await _send(config, phone, {"type": "text", "text": {"body": text}})
    if r.ok:
        return {"ok": True, "message_id": r.message_id}
    return {"ok": False, "reason": r.error or "api_error", "error": r.error, "status": r.status_code}


async def send_whatsapp_image(phone: str, image_url: str, caption: str, config: dict) -> dict:
    r = await _send(config, phone, {"type": "image", "image": {"link": image_url, "caption": (caption or "")[:1024]}})
    if r.ok:
        return {"ok": True, "message_id": r.message_id}
    return {"ok": False, "reason": r.error or "api_error", "error": r.error, "status": r.status_code}
