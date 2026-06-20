import json
import httpx
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
@router.get("/settings/public")
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
@router.get("/settings/whatsapp-cloud")
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
            raw = company_row["settings_json"]
            company_settings = raw if isinstance(raw, dict) else json.loads(raw)
            # Merge: company overrides global
            all_settings = {**all_settings, **company_settings}

        # Also read Tokko from companies table (source of truth)
        try:
            co_row = db.execute(
                text("SELECT tokko_enabled, tokko_api_key FROM companies WHERE id = :cid LIMIT 1"),
                {"cid": company_id},
            ).mappings().first()
            if co_row:
                all_settings["tokkoEnabled"] = bool(co_row["tokko_enabled"])
                if co_row["tokko_api_key"]:
                    all_settings["tokkoApiKey"] = co_row["tokko_api_key"]
        except Exception:
            pass

        # Auto-generate WA Cloud verify token per company if not set
        if not all_settings.get("waCloudVerifyToken"):
            import secrets as _sec2, json as _js2
            new_wct = _sec2.token_urlsafe(24)
            all_settings["waCloudVerifyToken"] = new_wct
            try:
                _r2 = db.execute(
                    text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
                    {"cid": company_id}
                ).mappings().first()
                _c2 = {}
                if _r2 and _r2["settings_json"]:
                    _raw2 = _r2["settings_json"]
                    _c2 = _raw2 if isinstance(_raw2, dict) else _js2.loads(_raw2)
                _c2["waCloudVerifyToken"] = new_wct
                db.execute(
                    text("INSERT INTO company_runtime_settings (company_id, settings_json, updated_at) VALUES (:cid, :sj, NOW()) ON CONFLICT (company_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()"),
                    {"cid": company_id, "sj": _js2.dumps(_c2)}
                )
                db.commit()
            except Exception:
                pass

        # Auto-generate webhook verify token per company if not set
        if not all_settings.get("metaLeadAdsWebhookVerifyToken"):
            import secrets as _sec, json as _js
            new_token = _sec.token_urlsafe(32)
            all_settings["metaLeadAdsWebhookVerifyToken"] = new_token
            try:
                _r = db.execute(
                    text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
                    {"cid": company_id}
                ).mappings().first()
                _c = {}
                if _r and _r["settings_json"]:
                    _raw = _r["settings_json"]
                    _c = _raw if isinstance(_raw, dict) else _js.loads(_raw)
                _c["metaLeadAdsWebhookVerifyToken"] = new_token
                db.execute(
                    text("INSERT INTO company_runtime_settings (company_id, settings_json, updated_at) VALUES (:cid, :sj, NOW()) ON CONFLICT (company_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()"),
                    {"cid": company_id, "sj": _js.dumps(_c)}
                )
                db.commit()
            except Exception:
                pass

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
            "metaLeadAdsWebhookVerifyToken": wa_cloud.get("metaLeadAdsWebhookVerifyToken", ""),
            "waCloudVerifyToken": wa_cloud.get("waCloudVerifyToken", ""),
        },
    }


# ── PUT /api/settings/whatsapp-cloud ─────────────────────────────
class WhatsAppCloudUpdate(BaseModel):
    settings: dict[str, Any]
    allow_clear_sensitive: bool = False


@router.put("/settings/whatsapp-cloud")
def update_whatsapp_cloud_settings(
    body: WhatsAppCloudUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Update WhatsApp Cloud settings (admin only)."""
    require_admin(payload)

    company_id = payload.get("companyId")
    settings_to_save = body.settings or {}

    sensitive_keys = [
        "waCloudVerifyToken",
        "waCloudPhoneNumberId",
        "waCloudAccessToken",
        "waCloudAppSecret",
        "tokkoApiKey",
    ]

    if company_id:
        row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :company_id LIMIT 1"),
            {"company_id": company_id},
        ).mappings().first()

        current_settings = {}
        if row and row.get("settings_json"):
            try:
                current_settings = json.loads(row["settings_json"]) if isinstance(row["settings_json"], str) else (row["settings_json"] or {})
            except Exception:
                current_settings = {}

        merged_settings = {**current_settings, **settings_to_save}
        prevented_clears = []

        if not body.allow_clear_sensitive:
            for key in sensitive_keys:
                if key in settings_to_save:
                    new_val = settings_to_save.get(key)
                    old_val = current_settings.get(key)
                    if (new_val is None or new_val == "") and old_val not in (None, ""):
                        merged_settings[key] = old_val
                        prevented_clears.append(key)

        db.execute(
            text("INSERT INTO company_runtime_settings (company_id, settings_json, updated_at) VALUES (:company_id, :settings_json, NOW()) ON CONFLICT (company_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()"),
            {"company_id": company_id, "settings_json": json.dumps(merged_settings)},
        )
        # Sync Tokko fields to companies table (source of truth for orchestrator)
        try:
            tokko_updates = {}
            if "tokkoEnabled" in settings_to_save:
                tokko_updates["tokko_enabled"] = bool(settings_to_save["tokkoEnabled"])
            if "tokkoApiKey" in settings_to_save and settings_to_save["tokkoApiKey"]:
                tokko_updates["tokko_api_key"] = settings_to_save["tokkoApiKey"]
            if tokko_updates:
                set_clause = ", ".join(f"{k} = :{k}" for k in tokko_updates)
                db.execute(
                    text(f"UPDATE companies SET {set_clause} WHERE id = :cid"),
                    {**tokko_updates, "cid": company_id},
                )
        except Exception:
            pass
        db.commit()
        return {"ok": True, "merged": True, "preventedClears": prevented_clears}
    else:
        updated = _save_settings(settings_to_save)
        if not body.allow_clear_sensitive:
            current = _read_file_settings()
            prevented_clears = []
            for key in sensitive_keys:
                if key in settings_to_save and (settings_to_save.get(key) is None or settings_to_save.get(key) == ""):
                    if current.get(key) not in (None, ""):
                        updated[key] = current.get(key)
                        prevented_clears.append(key)
            if prevented_clears:
                _write_file_settings(updated)
                return {"ok": True, "merged": True, "preventedClears": prevented_clears}

        return {"ok": True, "merged": True}


# ── POST /api/settings/whatsapp-cloud/test ───────────────────────
class WhatsAppCloudTestRequest(BaseModel):
    accessToken: str | None = None
    phoneNumberId: str | None = None


@router.post("/settings/whatsapp-cloud/test")
def test_whatsapp_cloud_connection(
    body: WhatsAppCloudTestRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Validate WhatsApp Cloud credentials against the Meta Graph API.

    Accepts credentials in the body (test BEFORE saving) or falls back to the
    stored per-company settings. Returns the verified phone name so the user
    gets immediate, human-readable confirmation that the connection works.
    """
    company_id = payload.get("companyId")

    access_token = (body.accessToken or "").strip()
    phone_number_id = (body.phoneNumberId or "").strip()

    if not access_token or not phone_number_id:
        stored = _get_all_settings()
        if company_id:
            row = db.execute(
                text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
                {"cid": company_id},
            ).mappings().first()
            if row and row["settings_json"]:
                raw = row["settings_json"]
                stored = {**stored, **(raw if isinstance(raw, dict) else json.loads(raw))}
        access_token = access_token or str(stored.get("waCloudAccessToken") or "")
        phone_number_id = phone_number_id or str(stored.get("waCloudPhoneNumberId") or "")

    if not access_token:
        raise HTTPException(status_code=400, detail="Falta el Access Token (ingresalo o guardalo primero)")
    if not phone_number_id:
        raise HTTPException(status_code=400, detail="Falta el Phone Number ID (ingresalo o guardalo primero)")

    import httpx
    try:
        resp = httpx.get(
            f"https://graph.facebook.com/v21.0/{phone_number_id}",
            params={"fields": "display_phone_number,verified_name,quality_rating"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=12,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"No se pudo contactar a Meta: {str(e)[:150]}")

    if resp.status_code != 200:
        try:
            err = resp.json().get("error", {})
            meta_msg = err.get("message", "")
            code = err.get("code")
        except Exception:
            meta_msg, code = resp.text[:200], None
        hint = ""
        if code == 190:
            hint = " El Access Token es inválido o expiró. Generá uno nuevo en Meta Developers."
        elif resp.status_code == 404 or code == 100:
            hint = " El Phone Number ID no existe o el token no tiene permiso sobre ese número."
        raise HTTPException(status_code=400, detail=f"Meta rechazó las credenciales: {meta_msg}.{hint}")

    data = resp.json()
    return {
        "ok": True,
        "displayPhoneNumber": data.get("display_phone_number", ""),
        "verifiedName": data.get("verified_name", ""),
        "qualityRating": data.get("quality_rating", ""),
    }


# ── GET /api/settings/integrations/api-key ────────────────────────
@router.get("/settings/integrations/api-key")
def get_integration_api_key(
    payload: dict = Depends(get_current_user_payload),
):
    """Get integration API key status (admin only)."""
    require_admin(payload)

    # This would typically come from environment variable
    return {"configured": False, "apiKeyMasked": ""}


@router.get("/settings/meta/webhook-status")
def get_meta_webhook_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    import json as _js
    company_id = payload.get("companyId")
    s = {}
    if company_id:
        try:
            row = db.execute(
                text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
                {"cid": company_id}
            ).mappings().first()
            if row and row["settings_json"]:
                raw = row["settings_json"]
                s = raw if isinstance(raw, dict) else _js.loads(raw)
        except Exception:
            pass
    base_url = "https://login.charlott.ai/api/ai"
    callback_url = f"{base_url}/meta-leads/webhook/{company_id}" if company_id else f"{base_url}/meta-leads/webhook"
    return {
        "callbackUrl": callback_url,
        "verifyTokenConfigured": bool(s.get("metaLeadAdsWebhookVerifyToken")),
        "appIdConfigured": bool(s.get("metaLeadAdsAppId")),
        "appSecretConfigured": bool(s.get("metaLeadAdsAppSecret")),
        "pageIdConfigured": bool(s.get("metaLeadAdsPageId")),
    }


@router.get("/settings/whatsapp-cloud/health")
def get_whatsapp_cloud_health(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Ping Meta Graph API to verify WhatsApp Cloud token and phone_number_id are live.

    Returns: {ok, phoneIdConfigured, tokenConfigured, error, expired, verifiedName, displayPhoneNumber}
    """
    import json as _js, httpx as _httpx
    company_id = payload.get("companyId")
    s = {}
    if company_id:
        try:
            row = db.execute(
                text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
                {"cid": company_id}
            ).mappings().first()
            if row and row["settings_json"]:
                raw = row["settings_json"]
                s = raw if isinstance(raw, dict) else _js.loads(raw)
        except Exception:
            pass
    phone_id = s.get("waCloudPhoneNumberId")
    token = s.get("waCloudAccessToken")
    result = {
        "ok": False,
        "phoneIdConfigured": bool(phone_id),
        "tokenConfigured": bool(token),
        "expired": False,
        "error": None,
        "verifiedName": None,
        "displayPhoneNumber": None,
    }
    if not phone_id or not token:
        result["error"] = "not_configured"
        return result
    try:
        url = f"https://graph.facebook.com/v21.0/{phone_id}"
        resp = _httpx.get(
            url,
            params={"fields": "verified_name,display_phone_number", "access_token": token},
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            result["ok"] = True
            result["verifiedName"] = data.get("verified_name")
            result["displayPhoneNumber"] = data.get("display_phone_number")
        else:
            try:
                err = resp.json().get("error", {})
            except Exception:
                err = {}
            code = err.get("code")
            msg = err.get("message", resp.text[:200])
            # code 190 = OAuthException (expired/invalid token)
            if code == 190 or "expired" in msg.lower() or "Session has expired" in msg:
                result["expired"] = True
            result["error"] = f"code={code} {msg[:160]}"
    except Exception as e:
        result["error"] = f"exception: {str(e)[:160]}"
    return result


# ── Queues ────────────────────────────────────────────────────────────

@router.get("/queues")
def list_queues(payload: dict = Depends(get_current_user_payload), db: Session = Depends(get_db)):
    from sqlalchemy import text
    company_id = payload.get("companyId")
    rows = db.execute(
        text('SELECT id, name, status FROM whatsapps WHERE "companyId" = :companyId ORDER BY id'),
        {"companyId": company_id},
    ).mappings().all()
    return [{"id": r["id"], "name": r["name"], "color": "#1976d2", "greetingMessage": ""} for r in rows]


@router.post("/queues", status_code=201)
def create_queue(body: dict, payload: dict = Depends(get_current_user_payload)):
    return {"id": 0, "name": body.get("name", ""), "color": body.get("color", "#1976d2"), "greetingMessage": body.get("greetingMessage", ""), "note": "Queue creation not implemented — manage via Connections"}


# ── Runtime settings (Bloque 8: single source of truth) ──────────────

@router.get("/settings/runtime")
def get_runtime_settings(payload: dict = Depends(get_current_user_payload)):
    """View all runtime-settings.json values (admin only)."""
    require_admin(payload)
    from app.api.v1.endpoints._ai_shared import _get_runtime_settings
    return _get_runtime_settings()


@router.put("/settings/runtime")
def update_runtime_settings(body: dict, payload: dict = Depends(get_current_user_payload)):
    """Patch runtime-settings.json. Only whitelisted keys are accepted (admin only)."""
    require_admin(payload)
    from app.api.v1.endpoints._ai_shared import _save_runtime_settings

    ALLOWED_KEYS = {
        "routingRulesJson", "slaMinutes", "slaAutoReassign", "slaSuggestOnly",
        "followUpDaysJson", "dedupeStrictEmail", "metaLeadAdsWebhookVerifyToken",
        "metaLeadAdsAppId", "metaLeadAdsAppSecret", "metaLeadAdsPageId",
        "metaOauthRedirectUri",
    }
    patch = {k: v for k, v in body.items() if k in ALLOWED_KEYS}
    if not patch:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="No whitelisted keys in payload")
    return _save_runtime_settings(patch)
