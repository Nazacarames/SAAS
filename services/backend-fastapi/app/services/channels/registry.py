from __future__ import annotations

import json
import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .base import ChannelAdapter
from .instagram import InstagramAdapter
from .messenger import MessengerAdapter
from .whatsapp import WhatsAppAdapter

log = logging.getLogger("app.channels.registry")

_adapters: dict[str, ChannelAdapter] = {
    "whatsapp": WhatsAppAdapter(),
    "instagram": InstagramAdapter(),
    "messenger": MessengerAdapter(),
}


def get_adapter(channel_type: str) -> ChannelAdapter | None:
    return _adapters.get(channel_type)


def resolve_channel(db: Session, channel_type: str, external_id: str) -> Optional[dict]:
    row = db.execute(
        text(
            """SELECT c.id, c.company_id, c.channel_type, c.name, c.status,
                      c.external_id, c.meta_connection_id, c.config_json,
                      mc.access_token AS mc_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.channel_type = :ct AND c.external_id = :eid
               LIMIT 1"""
        ),
        {"ct": channel_type, "eid": external_id},
    ).mappings().first()
    if not row:
        return None
    d = dict(row)
    cfg = d.get("config_json", "{}")
    d["_config"] = json.loads(cfg) if isinstance(cfg, str) else cfg
    return d


def resolve_channel_by_id(db: Session, channel_id: int) -> Optional[dict]:
    row = db.execute(
        text(
            """SELECT c.id, c.company_id, c.channel_type, c.name, c.status,
                      c.external_id, c.meta_connection_id, c.config_json,
                      mc.access_token AS mc_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.id = :cid"""
        ),
        {"cid": channel_id},
    ).mappings().first()
    if not row:
        return None
    d = dict(row)
    cfg = d.get("config_json", "{}")
    d["_config"] = json.loads(cfg) if isinstance(cfg, str) else cfg
    return d


def get_send_config(channel: dict) -> dict:
    cfg = channel.get("_config", {})
    token = channel.get("mc_token") or cfg.get("waCloudAccessToken") or ""
    return {
        "phoneId": channel["external_id"],
        "external_id": channel["external_id"],
        "token": token,
    }


def get_primary_channel(db: Session, company_id: int, channel_type: str = "whatsapp") -> Optional[dict]:
    row = db.execute(
        text(
            """SELECT c.id, c.company_id, c.channel_type, c.name, c.status,
                      c.external_id, c.meta_connection_id, c.config_json,
                      mc.access_token AS mc_token
               FROM channels c
               LEFT JOIN meta_connections mc ON mc.id = c.meta_connection_id
               WHERE c.company_id = :cid AND c.channel_type = :ct AND c.status = 'active'
               ORDER BY c.id ASC LIMIT 1"""
        ),
        {"cid": company_id, "ct": channel_type},
    ).mappings().first()
    if not row:
        return None
    d = dict(row)
    cfg = d.get("config_json", "{}")
    d["_config"] = json.loads(cfg) if isinstance(cfg, str) else cfg
    return d
