from __future__ import annotations

import logging
from typing import Optional

import httpx

from .base import ChannelAdapter, ContactProfile, InboundMessage, SendResult

log = logging.getLogger("app.channels.messenger")

GRAPH_VERSION = "v21.0"


class MessengerAdapter(ChannelAdapter):
    channel_type = "messenger"

    def parse_inbound(self, entry: dict) -> list[InboundMessage]:
        out: list[InboundMessage] = []
        page_id = str(entry.get("id", ""))
        for event in entry.get("messaging", []):
            msg = event.get("message", {})
            if not msg:
                continue
            sender = event.get("sender", {}).get("id", "")
            if sender == page_id:
                continue
            text = msg.get("text", "")
            attachments = msg.get("attachments", [])
            media_url = attachments[0].get("payload", {}).get("url") if attachments else None
            media_type = attachments[0].get("type") if attachments else None
            if not text and media_type:
                text = f"[{media_type} message]"
            out.append(InboundMessage(
                channel_type="messenger",
                external_id=page_id,
                sender_id=sender,
                sender_kind="psid",
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
        """Nombre real del contacto de Messenger.

        La API de perfil (GET /{psid}) sigue sin devolver nada aunque el permiso
        pages_messaging esté con acceso avanzado: contesta "Object with ID ...
        does not exist". El nombre sí viene por las conversaciones de la página,
        que es el camino que se usa como respaldo.
        """
        token = config.get("token", "")
        page_id = str(config.get("external_id") or "")
        if not token:
            return ContactProfile()
        base = f"https://graph.facebook.com/{GRAPH_VERSION}"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(f"{base}/{recipient_id}",
                                        params={"fields": "name,profile_pic", "access_token": token})
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("name"):
                        return ContactProfile(name=data["name"], profile_pic=data.get("profile_pic", ""))

                if not page_id:
                    return ContactProfile()
                # el hilo del cliente con la página: participants trae el nombre
                resp = await client.get(f"{base}/{page_id}/conversations",
                                        params={"access_token": token, "user_id": recipient_id,
                                                "fields": "participants", "limit": 1})
                if resp.status_code != 200:
                    return ContactProfile()
                for conv in (resp.json().get("data") or []):
                    for p in ((conv.get("participants") or {}).get("data") or []):
                        if str(p.get("id")) == str(recipient_id) and p.get("name"):
                            return ContactProfile(name=p["name"])
        except Exception as e:
            log.warning("msg fetch_profile err=%s", str(e)[:100])
        return ContactProfile()

    def recipient_id_of(self, contact: dict) -> str | None:
        return contact.get("psid")


async def _send(config: dict, recipient: str, message: dict) -> SendResult:
    token = config.get("token", "")
    if not token:
        return SendResult(ok=False, error="messenger_not_configured")

    url = f"https://graph.facebook.com/{GRAPH_VERSION}/me/messages"
    headers = {"Content-Type": "application/json"}
    payload = {"recipient": {"id": recipient}, "message": message, "access_token": token}

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code in (200, 201):
            data = resp.json()
            return SendResult(ok=True, message_id=data.get("message_id", ""))
        log.warning("msg_send_failed status=%s to=%s err=%s", resp.status_code, recipient[:8], resp.text[:200])
        return SendResult(ok=False, error=resp.text[:200], status_code=resp.status_code)
    except Exception as e:
        log.warning("msg_send_exception err=%s", str(e)[:200])
        return SendResult(ok=False, error=str(e)[:200])
