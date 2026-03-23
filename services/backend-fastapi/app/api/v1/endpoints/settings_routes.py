import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin
from app.core.config import settings
from app.core.db import get_db

router = APIRouter(prefix="", tags=["settings"])

# ── Settings file path ────────────────────────────────────────────
_SETTINGS_FILE = Path(__file__).parent.parent.parent.parent / "runtime-settings.json"


def _mask_key(key: str) -> str:
    """Mask API keys for display (show first 4 and last 4 chars)."""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}{'*' * max(4, len(key) - 8)}{key[-4:]}"


def _read_file_settings() -> dict[str, Any]:
    """Read global runtime settings from JSON file."""
    if not _SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(_SETTINGS_FILE.read_text() or "{}")
    except Exception:
        return {}


def _write_file_settings(settings_dict: dict[str, Any]) -> None:
    """Write global runtime settings to JSON file."""
    _SETTINGS_FILE.write_text(json.dumps(settings_dict, indent=2))


def _get_all_settings() -> dict[str, Any]:
    """Get all settings (global file + env vars)."""
    from app.core.config import settings as app_settings

    file_settings = _read_file_settings()

    # Build full settings dict merging file + env
    result = {
        # WhatsApp Cloud
        "waCloudVerifyToken": file_settings.get("waCloudVerifyToken") or "",
        "waCloudPhoneNumberId": file_settings.get("waCloudPhoneNumberId") or "",
        "waCloudAccessToken": file_settings.get("waCloudAccessToken") or "",
        "waCloudAppSecret": file_settings.get("waCloudAppSecret") or "",
        "waCloudDefaultWhatsappId": int(file_settings.get("waCloudDefaultWhatsappId") or 1),
        # WhatsApp Recap
        "waRecapEnabled": bool(file_settings.get("waRecapEnabled", False)),
        "waRecapTemplateName": file_settings.get("waRecapTemplateName") or "",
        "waRecapTemplateLang": file_settings.get("waRecapTemplateLang") or "es_AR",
        "waRecapInactivityMinutes": int(file_settings.get("waRecapInactivityMinutes") or 4320),
        # Agent
        "agentGuardrailsEnabled": bool(file_settings.get("agentGuardrailsEnabled", True)),
        "agentConversationPoliciesJson": file_settings.get(
            "agentConversationPoliciesJson"
        ) or '{"sales":{"maxReplyChars":280,"allowAutoClose":false},"support":{"maxReplyChars":320,"allowAutoClose":false}}',
        "agentDomainProfileJson": file_settings.get(
            "agentDomainProfileJson"
        ) or '{"domainLabel":"negocio","assistantIdentity":"asistente comercial","primaryObjective":"entender necesidad"}',
        # Tokko
        "tokkoEnabled": bool(file_settings.get("tokkoEnabled", False)),
        "tokkoApiKey": file_settings.get("tokkoApiKey") or "",
        "tokkoBaseUrl": file_settings.get("tokkoBaseUrl") or "https://www.tokkobroker.com/api/v1",
        "tokkoLeadsPath": file_settings.get("tokkoLeadsPath") or "/webcontact/",
        "tokkoPropertiesPath": file_settings.get("tokkoPropertiesPath") or "/property/",
        "tokkoSyncLeadsEnabled": bool(file_settings.get("tokkoSyncLeadsEnabled", True)),
        "tokkoAgentSearchEnabled": bool(file_settings.get("tokkoAgentSearchEnabled", True)),
        "tokkoSyncContactsEnabled": bool(file_settings.get("tokkoSyncContactsEnabled", False)),
        "tokkoDebugLogsEnabled": bool(file_settings.get("tokkoDebugLogsEnabled", False)),
        "tokkoRateLimitEnabled": bool(file_settings.get("tokkoRateLimitEnabled", True)),
        "tokkoCooldownSeconds": int(file_settings.get("tokkoCooldownSeconds") or 10),
        "tokkoSafeWriteMode": bool(file_settings.get("tokkoSafeWriteMode", True)),
        "tokkoTabVisible": bool(file_settings.get("tokkoTabVisible", True)),
        # Meta Lead Ads
        "metaLeadAdsEnabled": bool(file_settings.get("metaLeadAdsEnabled", False)),
        "metaLeadAdsWebhookVerifyToken": file_settings.get("metaLeadAdsWebhookVerifyToken") or "",
        "metaLeadAdsAppId": file_settings.get("metaLeadAdsAppId") or "",
        "metaLeadAdsAppSecret": file_settings.get("metaLeadAdsAppSecret") or "",
        "metaLeadAdsPageId": file_settings.get("metaLeadAdsPageId") or "",
        "metaPropertyCarouselTemplateName": file_settings.get("metaPropertyCarouselTemplateName") or "propiedades_carrusel",
        "metaPropertyCarouselTemplateLanguage": file_settings.get("metaPropertyCarouselTemplateLanguage") or "en_US",
        # SLA
        "slaEnabled": bool(file_settings.get("slaEnabled", True)),
        "slaMinutes": int(file_settings.get("slaMinutes") or 60),
        "slaAutoReassign": bool(file_settings.get("slaAutoReassign", False)),
        "slaSuggestOnly": bool(file_settings.get("slaSuggestOnly", True)),
        # Follow-up
        "followUpEnabled": bool(file_settings.get("followUpEnabled", True)),
        "followUpDaysJson": file_settings.get("followUpDaysJson") or "[1, 3, 7]",
        "routingRulesJson": file_settings.get("routingRulesJson") or "[]",
        "dedupeStrictEmail": bool(file_settings.get("dedupeStrictEmail", False)),
        # WhatsApp hardening (outbound)
        "waOutboundDedupeTtlSeconds": int(file_settings.get("waOutboundDedupeTtlSeconds") or 120),
        "waOutboundRetryMaxAttempts": int(file_settings.get("waOutboundRetryMaxAttempts") or 3),
        "waOutboundRetryMaxDelayMs": int(file_settings.get("waOutboundRetryMaxDelayMs") or 2000),
        "waOutboundRequestTimeoutMs": int(file_settings.get("waOutboundRequestTimeoutMs") or 12000),
        "waOutboundDedupeFailClosed": bool(file_settings.get("waOutboundDedupeFailClosed", True)),
        "waOutboundRetryOnTimeout": bool(file_settings.get("waOutboundRetryOnTimeout", False)),
        "waOutboundRetryRequireIdempotencyKey": bool(file_settings.get("waOutboundRetryRequireIdempotencyKey", True)),
        # WhatsApp hardening (inbound)
        "waInboundReplayTtlSeconds": int(file_settings.get("waInboundReplayTtlSeconds") or 900),
        "waInboundReplayMaxBlocksPerPayload": int(file_settings.get("waInboundReplayMaxBlocksPerPayload") or 3),
        # Webhook hardening
        "waWebhookReplayWindowSeconds": int(file_settings.get("waWebhookReplayWindowSeconds") or 120),
        "waWebhookFutureSkewSeconds": int(file_settings.get("waWebhookFutureSkewSeconds") or 120),
        "waWebhookEventNonceCacheMaxEntries": int(file_settings.get("waWebhookEventNonceCacheMaxEntries") or 20000),
        "waWebhookAllowUnsigned": bool(file_settings.get("waWebhookAllowUnsigned", False)),
    }
    return result


def _save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    """Save global runtime settings (partial update)."""
    current = _read_file_settings()
    next_settings = {**current, **patch}
    _write_file_settings(next_settings)
    return _get_all_settings()


# ── Schemas ───────────────────────────────────────────────────────
class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


class WhatsAppCloudSettings(BaseModel):
    configured: dict[str, bool]
    settings: dict[str, Any]


# ── GET /api/settings/public ──────────────────────────────────────
@router.get("/api/settings/public")
def get_public_settings():
    """Public settings (no auth required)."""
    all_settings = _get_all_settings()
    return {
        "leadScoreHot": int(all_settings.get("leadScoreHot", 75)),
        "leadScoreWarm": int(all_settings.get("leadScoreWarm", 50)),
        "leadScoreContacted": int(all_settings.get("leadScoreContacted", 25)),
        "conversationPollIntervalMs": int(all_settings.get("conversationPollIntervalMs", 30000)),
        "dashboardPollIntervalMs": int(all_settings.get("dashboardPollIntervalMs", 60000)),
    }


# ── GET /api/settings/whatsapp-cloud ─────────────────────────────
@router.get("/api/settings/whatsapp-cloud")
def get_whatsapp_cloud_settings(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Get WhatsApp Cloud settings (admin only)."""
    require_admin(payload)

    all_settings = _get_all_settings()

    # Check company-specific override
    company_id = payload.get("companyId")
    if company_id:
        company_row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :company_id LIMIT 1"),
            {"company_id": company_id},
        ).mappings().first()
        if company_row and company_row["settings_json"]:
            company_settings = json.loads(company_row["settings_json"])
            # Merge: company overrides global
            all_settings = {**all_settings, **company_settings}

    # Mask sensitive values
    wa_cloud = all_settings
    safe_settings = {k: v for k, v in wa_cloud.items() if "Token" not in k and "Key" not in k and "Secret" not in k}

    return {
        "configured": {
            "verifyToken": bool(wa_cloud.get("waCloudVerifyToken")),
            "phoneNumberId": bool(wa_cloud.get("waCloudPhoneNumberId")),
            "accessToken": bool(wa_cloud.get("waCloudAccessToken")),
            "appSecret": bool(wa_cloud.get("waCloudAppSecret")),
            "recapTemplate": bool(wa_cloud.get("waRecapTemplateName")),
            "tokkoApiKey": bool(wa_cloud.get("tokkoApiKey")),
            "metaLeadAdsAppSecret": bool(wa_cloud.get("metaLeadAdsAppSecret")),
        },
        "settings": {
            **safe_settings,
            "waCloudVerifyTokenMasked": _mask_key(wa_cloud.get("waCloudVerifyToken", "")),
            "waCloudAccessTokenMasked": _mask_key(wa_cloud.get("waCloudAccessToken", "")),
            "waCloudAppSecretMasked": _mask_key(wa_cloud.get("waCloudAppSecret", "")),
            "tokkoApiKeyMasked": _mask_key(wa_cloud.get("tokkoApiKey", "")),
            "metaLeadAdsAppSecretMasked": _mask_key(wa_cloud.get("metaLeadAdsAppSecret", "")),
        },
    }


# ── PUT /api/settings/whatsapp-cloud ─────────────────────────────
class WhatsAppCloudUpdate(BaseModel):
    settings: dict[str, Any]


@router.put("/api/settings/whatsapp-cloud")
def update_whatsapp_cloud_settings(
    body: WhatsAppCloudUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Update WhatsApp Cloud settings (admin only)."""
    require_admin(payload)

    company_id = payload.get("companyId")
    settings_to_save = body.settings

    if company_id:
        # Save per-company override
        db.execute(
            text(
                """INSERT INTO company_runtime_settings (company_id, settings_json, updated_at)
                   VALUES (:company_id, :settings_json, NOW())
                   ON CONFLICT (company_id)
                   DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()"""
            ),
            {"company_id": company_id, "settings_json": json.dumps(settings_to_save)},
        )
        db.commit()
    else:
        # Save global settings
        _save_settings(settings_to_save)

    return {"ok": True}


# ── GET /api/settings/integrations/api-key ────────────────────────
@router.get("/api/settings/integrations/api-key")
def get_integration_api_key(
    payload: dict = Depends(get_current_user_payload),
):
    """Get integration API key status (admin only)."""
    require_admin(payload)

    # This would typically come from environment variable
    return {"configured": False, "apiKeyMasked": ""}
