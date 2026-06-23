from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("app.channels")


@dataclass
class InboundMessage:
    channel_type: str
    external_id: str
    sender_id: str
    sender_kind: str  # 'phone' | 'psid' | 'igsid'
    text: str
    media_url: Optional[str] = None
    media_type: Optional[str] = None
    provider_message_id: str = ""
    timestamp: Optional[int] = None
    raw: dict = field(default_factory=dict)


@dataclass
class ContactProfile:
    name: str = ""
    username: str = ""
    profile_pic: str = ""


@dataclass
class SendResult:
    ok: bool
    message_id: str = ""
    error: str = ""
    status_code: int = 0


class ChannelAdapter(ABC):
    channel_type: str = ""

    @abstractmethod
    def parse_inbound(self, entry: dict) -> list[InboundMessage]:
        ...

    @abstractmethod
    async def send_text(self, config: dict, recipient: str, text: str) -> SendResult:
        ...

    @abstractmethod
    async def send_media(self, config: dict, recipient: str, media_url: str, caption: str | None = None) -> SendResult:
        ...

    @abstractmethod
    async def fetch_profile(self, config: dict, recipient_id: str) -> ContactProfile:
        ...

    @abstractmethod
    def recipient_id_of(self, contact: dict) -> str | None:
        ...
