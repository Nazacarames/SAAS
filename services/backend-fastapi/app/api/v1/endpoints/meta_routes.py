"""Meta OAuth, Meta Leads webhook, message templates, reports, hardening."""
import hashlib
import hmac
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user_payload, require_admin, get_db
from app.core.config import settings
from app.api.v1.endpoints._ai_shared import (
    TemplateCreate, TemplateUpdate, MetaOAuthTestSendRequest,
    _ensure_meta_oauth_tables, _ensure_meta_lead_tables, _ensure_template_tables,
    _get_runtime_settings, _save_runtime_settings, _render_template,
    GRAPH_API_VERSION,
)

router = APIRouter()


# ── Hardening ─────────────────────────────────────────────────────────

@router.get("/hardening/wa-cloud")
def get_wa_hardening(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    failOnAlert: str = Query(""),
):
    require_admin(payload)
    inbound_metrics = {"requests": 0, "blocked": 0, "alerts": []}
    outbound_metrics = {"sent": 0, "failed": 0, "alerts": []}
    meta_webhook_metrics = {"received": 0, "processed": 0, "alerts": []}

    pending_alerts = []
    pending_critical = sum(1 for a in pending_alerts if str(a.get("severity", "")).lower() == "critical")
    status = "critical" if pending_critical > 0 else "warn" if pending_alerts else "ok"
    status_code = 503 if failOnAlert.lower() in ("1", "true", "yes", "on") and pending_alerts else 200

    return {
        "ok": len(pending_alerts) == 0,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "hardening": {
            "status": status,
            "pendingAlertCount": len(pending_alerts),
            "failOnAlert": failOnAlert.lower() in ("1", "true", "yes", "on"),
            "pendingCriticalCount": pending_critical,
            "inbound": inbound_metrics,
            "outbound": outbound_metrics,
            "metaWebhook": meta_webhook_metrics,
        }
    }


# ── Reports ───────────────────────────────────────────────────────────

@router.get("/reports/attribution")
def get_reports_attribution(
    from_date: str = Query(""),
    to_date: str = Query(""),
    source: str = Query(""),
    campaign: str = Query(""),
    form: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_lead_tables(db)
    company_id = payload.get("companyId")

    where_clauses = [
        "company_id = :companyId",
        r"(COALESCE(leadgen_id,'') <> '' AND (NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\D', '', 'g'), '') IS NOT NULL OR COALESCE(contact_email,'') <> '' OR COALESCE(contact_name,'') <> '' OR COALESCE(form_fields_json,'') NOT IN ('','{}','[]')))",
    ]
    params = {"companyId": company_id}

    if from_date:
        where_clauses.append("created_at >= :fromDate")
        params["fromDate"] = from_date
    if to_date:
        where_clauses.append("created_at < (:toDate::date + INTERVAL '1 day')")
        params["toDate"] = to_date
    if source:
        where_clauses.append("source = :source")
        params["source"] = source
    if campaign:
        where_clauses.append("LOWER(COALESCE(campaign_id,'')) LIKE LOWER(:campaign)")
        params["campaign"] = f"%{campaign}%"
    if form:
        where_clauses.append("(LOWER(COALESCE(form_name,'')) LIKE LOWER(:form) OR LOWER(COALESCE(form_id,'')) LIKE LOWER(:form))")
        params["form"] = f"%{form}%"

    base_where = " AND ".join(where_clauses)

    summary = db.execute(
        text(f"""SELECT COUNT(*)::int AS total_leads, COUNT(DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), ''))::int AS unique_phones,
                    COUNT(DISTINCT NULLIF(COALESCE(campaign_id,''), ''))::int AS campaigns,
                    COUNT(DISTINCT NULLIF(COALESCE(form_id,''), ''))::int AS forms
             FROM meta_lead_events WHERE {base_where}"""),
        params,
    ).mappings().first()

    by_source = db.execute(
        text(f"""SELECT COALESCE(NULLIF(source,''), 'unknown') AS source, COUNT(*)::int AS leads
             FROM meta_lead_events WHERE {base_where}
             GROUP BY COALESCE(NULLIF(source,''), 'unknown') ORDER BY leads DESC LIMIT 20"""),
        params,
    ).mappings().all()

    by_campaign = db.execute(
        text(f"""SELECT COALESCE(NULLIF(campaign_id,''), 'unknown') AS campaign, COUNT(*)::int AS leads
             FROM meta_lead_events WHERE {base_where}
             GROUP BY COALESCE(NULLIF(campaign_id,''), 'unknown') ORDER BY leads DESC LIMIT 30"""),
        params,
    ).mappings().all()

    timeline = db.execute(
        text(f"""SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS leads
             FROM meta_lead_events WHERE {base_where}
             GROUP BY created_at::date ORDER BY day DESC LIMIT 31"""),
        params,
    ).mappings().all()

    return {
        "summary": dict(summary) if summary else {"total_leads": 0, "unique_phones": 0, "campaigns": 0, "forms": 0},
        "bySource": [dict(r) for r in by_source],
        "byCampaign": [dict(r) for r in by_campaign],
        "timeline": [dict(r) for r in timeline],
    }


# ── Templates ─────────────────────────────────────────────────────────

@router.get("/templates")
def list_templates(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_template_tables(db)
    company_id = payload.get("companyId")
    rows = db.execute(
        text("SELECT * FROM message_templates WHERE company_id = :companyId ORDER BY id DESC"),
        {"companyId": company_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/templates", status_code=201)
def create_template(
    body: TemplateCreate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_template_tables(db)
    company_id = payload.get("companyId")
    user_id = payload.get("id")

    vars_json = body.variablesJson if isinstance(body.variablesJson, str) else json.dumps(body.variablesJson or [])

    row = db.execute(
        text("""INSERT INTO message_templates (company_id, name, category, channel, content, variables_json, is_active, created_by, created_at, updated_at)
            VALUES (:companyId, :name, :category, :channel, :content, :variablesJson, :isActive, :userId, NOW(), NOW())
            RETURNING *"""),
        {"companyId": company_id, "name": body.name, "category": body.category, "channel": body.channel,
         "content": body.content, "variablesJson": vars_json, "isActive": body.isActive, "userId": user_id},
    ).mappings().first()

    db.commit()
    return dict(row) if row else None


@router.put("/templates/{template_id}")
def update_template(
    template_id: int,
    body: TemplateUpdate,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_template_tables(db)
    company_id = payload.get("companyId")

    updates = []
    params = {"id": template_id, "companyId": company_id}

    for field, db_field, value in [
        ("name", "name", body.name),
        ("category", "category", body.category),
        ("channel", "channel", body.channel),
        ("content", "content", body.content),
        ("isActive", "is_active", body.isActive),
    ]:
        if value is not None:
            updates.append(f"{db_field} = :{field}")
            params[field] = value

    if body.variablesJson is not None:
        vars_json = body.variablesJson if isinstance(body.variablesJson, str) else json.dumps(body.variablesJson)
        updates.append("variables_json = :variablesJson")
        params["variablesJson"] = vars_json

    if updates:
        updates.append("updated_at = NOW()")
        db.execute(
            text(f"UPDATE message_templates SET {', '.join(updates)} WHERE id = :id AND company_id = :companyId"),
            params,
        )

    tmpl = db.execute(
        text("SELECT * FROM message_templates WHERE id = :id AND company_id = :companyId"),
        {"id": template_id, "companyId": company_id},
    ).mappings().first()

    db.commit()
    return dict(tmpl) if tmpl else None


@router.delete("/templates/{template_id}")
def delete_template(
    template_id: int,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    require_admin(payload)
    _ensure_template_tables(db)
    company_id = payload.get("companyId")

    db.execute(
        text("DELETE FROM message_templates WHERE id = :id AND company_id = :companyId"),
        {"id": template_id, "companyId": company_id},
    )
    db.commit()
    return {"ok": True, "deletedId": template_id}


@router.post("/templates/suggest")
def suggest_template(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_template_tables(db)
    company_id = payload.get("companyId")
    ticket_id = body.get("ticketId")
    contact_id = body.get("contactId")
    query_text = str(body.get("query", ""))

    row = db.execute(
        text("SELECT * FROM message_templates WHERE company_id = :companyId AND is_active = true ORDER BY id DESC LIMIT 1"),
        {"companyId": company_id},
    ).mappings().first()

    suggestion = {"templateId": row["id"], "content": row["content"], "variables": json.loads(row["variables_json"])} if row else None

    db.execute(
        text("""INSERT INTO template_suggestions_logs (company_id, ticket_id, contact_id, query_text, suggested_template_id, suggested_payload_json, created_at)
            VALUES (:companyId, :ticketId, :contactId, :queryText, :templateId, :payload, NOW())"""),
        {"companyId": company_id, "ticketId": ticket_id, "contactId": contact_id, "queryText": query_text,
         "templateId": suggestion["templateId"] if suggestion else None, "payload": json.dumps(suggestion or {})},
    )
    db.commit()

    return {"suggestion": suggestion}


@router.post("/templates/send")
def send_template(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
):
    return {"ok": True, "queued": True, "templateId": int(body.get("templateId") or 0), "ticketId": int(body.get("ticketId") or 0), "contactId": int(body.get("contactId") or 0), "payload": body.get("payload", {}), "note": "Scaffold: conectar envío real con canal WhatsApp/Cloud"}


@router.post("/templates/preview")
def preview_template(
    body: dict[str, Any],
    payload: dict = Depends(get_current_user_payload),
):
    template = str(body.get("template") or body.get("content") or "")
    variables = body.get("variables", {})
    missing = list(set(re.findall(r"{{\s*([a-zA-Z0-9_.-]+)\s*}}", template)) - set(variables.keys()))
    return {"rendered": _render_template(template, variables), "missingVariables": missing}


# ── Meta OAuth ────────────────────────────────────────────────────────

def _sign_meta_state(payload_str: str) -> str:
    secret = settings.meta_app_secret or settings.jwt_secret
    return hmac.new(secret.encode(), payload_str.encode(), hashlib.sha256).hexdigest()[:32]


def _get_meta_oauth_config() -> dict[str, str]:
    runtime = _get_runtime_settings()
    client_id = str(settings.meta_app_secret or runtime.get("metaLeadAdsAppId", "")).strip()
    client_secret = str(settings.meta_app_secret or runtime.get("metaLeadAdsAppSecret", "")).strip()
    redirect_uri = str(runtime.get("metaOauthRedirectUri", "https://login.charlott.ai/api/ai/meta/oauth/callback")).strip()
    return {"clientId": client_id, "clientSecret": client_secret, "redirectUri": redirect_uri}


@router.get("/meta/oauth/start")
def meta_oauth_start(
    request: Request,
    redirectAfter: str = Query("/settings"),
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_oauth_tables(db)
    oauth = _get_meta_oauth_config()
    if not oauth["clientId"] or not oauth["redirectUri"]:
        raise HTTPException(status_code=400, detail="missing_meta_oauth_config")

    company_id = int(payload.get("companyId") or 0)
    user_id = int(payload.get("id") or 0) or None

    import secrets
    import base64
    nonce = secrets.token_hex(16)
    state_payload = json.dumps({"companyId": company_id, "userId": user_id, "nonce": nonce, "ts": datetime.utcnow().timestamp()})
    payload_b64 = base64.urlsafe_b64encode(state_payload.encode()).decode().rstrip("=")
    sig = _sign_meta_state(payload_b64)
    state = f"{payload_b64}.{sig}"

    db.execute(
        text("""INSERT INTO meta_oauth_states (company_id, user_id, nonce, state_hash, redirect_after, status, expires_at)
            VALUES (:companyId, :userId, :nonce, :stateHash, :redirectAfter, 'pending', NOW() + INTERVAL '10 minutes')"""),
        {"companyId": company_id, "userId": user_id, "nonce": nonce,
         "stateHash": hashlib.sha256(state.encode()).hexdigest(), "redirectAfter": redirectAfter[:650]},
    )
    db.commit()

    scope = "whatsapp_business_management,whatsapp_business_messaging,business_management"
    from urllib.parse import urlencode
    oauth_url = f"https://www.facebook.com/{GRAPH_API_VERSION}/dialog/oauth?" + urlencode({
        "client_id": oauth["clientId"],
        "redirect_uri": oauth["redirectUri"],
        "state": state,
        "response_type": "code",
        "scope": scope,
    })

    return {"ok": True, "oauthUrl": oauth_url, "statePreview": f"{state[:10]}..."}


@router.get("/meta/oauth/callback")
def meta_oauth_callback(
    request: Request,
    error: str = Query(""),
    error_description: str = Query(""),
    code: str = Query(""),
    state: str = Query(""),
    db: Session = Depends(get_db),
):
    _ensure_meta_oauth_tables(db)

    if error:
        raise HTTPException(status_code=400, detail=f"Meta OAuth error: {error_description or error}")

    if not code or not state or "." not in state:
        raise HTTPException(status_code=400, detail="Missing code/state")

    import base64
    parts = state.split(".", 1)
    payload_b64, sig = parts[0], parts[1]
    if _sign_meta_state(payload_b64) != sig:
        raise HTTPException(status_code=400, detail="Invalid state signature")

    decoded = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)).decode())
    company_id = int(decoded.get("companyId") or 0)
    state_hash = hashlib.sha256(state.encode()).hexdigest()

    state_row = db.execute(
        text("""SELECT * FROM meta_oauth_states WHERE state_hash = :stateHash AND company_id = :companyId AND status = 'pending' AND expires_at > NOW() ORDER BY id DESC LIMIT 1"""),
        {"stateHash": state_hash, "companyId": company_id},
    ).mappings().first()

    if not state_row:
        raise HTTPException(status_code=400, detail="State expired/used")

    oauth = _get_meta_oauth_config()
    if not oauth["clientId"] or not oauth["clientSecret"] or not oauth["redirectUri"]:
        raise HTTPException(status_code=400, detail="Missing OAuth config on server")

    from urllib.parse import urlencode
    token_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/oauth/access_token?" + urlencode({
        "client_id": oauth["clientId"],
        "client_secret": oauth["clientSecret"],
        "redirect_uri": oauth["redirectUri"],
        "code": code,
    })

    import httpx
    token_resp = httpx.get(token_url, timeout=10)
    token_data = token_resp.json() if token_resp.status_code == 200 else {}
    if not token_resp.is_success or not token_data.get("access_token"):
        raise HTTPException(status_code=400, detail=f"Token exchange failed: {token_data.get('error', {}).get('message', token_resp.status_code)}")

    access_token = str(token_data["access_token"])

    me_resp = httpx.get(f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/businesses?fields=id,name&access_token={access_token}", timeout=10)
    me_businesses = me_resp.json() if me_resp.is_success else {}
    business_id = str(me_businesses.get("data", [{}])[0].get("id", ""))

    waba_id, phone_number_id, phone_display = "", "", ""
    if business_id:
        waba_resp = httpx.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{business_id}/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{{id,display_phone_number}}&access_token={access_token}",
            timeout=10,
        )
        waba_data = waba_resp.json() if waba_resp.is_success else {}
        waba_id = str(waba_data.get("data", [{}])[0].get("id", ""))
        phone_number_id = str(waba_data.get("data", [{}])[0].get("phone_numbers", {}).get("data", [{}])[0].get("id", ""))
        phone_display = str(waba_data.get("data", [{}])[0].get("phone_numbers", {}).get("data", [{}])[0].get("display_phone_number", ""))

    import datetime as dt
    expires_at = datetime.utcnow() + dt.timedelta(seconds=int(token_data.get("expires_in", 0))) if token_data.get("expires_in") else None

    db.execute(
        text("""INSERT INTO meta_connections (company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, access_token, token_type, token_expires_at, scopes_json, status, created_at, updated_at)
            VALUES (:companyId, :businessId, :wabaId, :phoneNumberId, :phoneDisplay, :accessToken, :tokenType, :expiresAt, :scopesJson, 'connected', NOW(), NOW())"""),
        {"companyId": company_id, "businessId": business_id or None, "wabaId": waba_id or None, "phoneNumberId": phone_number_id or None,
         "phoneDisplay": phone_display or None, "accessToken": access_token, "tokenType": str(token_data.get("token_type", "bearer")),
         "expiresAt": expires_at, "scopesJson": json.dumps(token_data.get("scope", []))},
    )

    db.execute(text("UPDATE meta_oauth_states SET status = 'used', used_at = NOW() WHERE id = :id"), {"id": state_row["id"]})
    db.commit()

    redirect_after = str(state_row.get("redirect_after") or "/settings")
    separator = "&" if "?" in redirect_after else "?"
    return {"redirect": f"{redirect_after}{separator}meta_oauth=ok"}


@router.get("/meta/oauth/status")
def meta_oauth_status(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_oauth_tables(db)
    company_id = payload.get("companyId")
    row = db.execute(
        text("""SELECT id, company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, token_expires_at, status, updated_at
             FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1"""),
        {"companyId": company_id},
    ).mappings().first()
    return dict(row) if row else {"connected": False}


@router.post("/meta/oauth/test-send")
def meta_oauth_test_send(
    body: MetaOAuthTestSendRequest,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
    x_idempotency_key: Optional[str] = Header(None),
    idempotency_key: Optional[str] = Header(None),
):
    _ensure_meta_oauth_tables(db)
    company_id = payload.get("companyId")
    to = re.sub(r"\D", "", body.to)
    if not to:
        raise HTTPException(status_code=400, detail="missing_to")

    conn = db.execute(
        text("SELECT * FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1"),
        {"companyId": company_id},
    ).mappings().first()

    if not conn or not conn.get("access_token") or not conn.get("phone_number_id"):
        raise HTTPException(status_code=400, detail="missing_connection_or_phone")

    effective_key = x_idempotency_key or idempotency_key or body.idempotencyKey

    import httpx
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {conn['access_token']}"}
    if effective_key:
        headers["Idempotency-Key"] = effective_key

    if body.templateName:
        payload_json = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "template",
            "template": {
                "name": body.templateName,
                "language": {"code": body.languageCode or "en"},
                **({"components": [{"type": "body", "parameters": [{"type": "text", "text": str(v)} for v in (body.templateVariables or [])]}]} if body.templateVariables else {}),
            },
        }
    else:
        payload_json = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": body.text}}

    resp = httpx.post(f"https://graph.facebook.com/{GRAPH_API_VERSION}/{conn['phone_number_id']}/messages", headers=headers, json=payload_json, timeout=30)
    data = resp.json() if resp.is_success else {}
    if not resp.is_success:
        raise HTTPException(status_code=400, detail=data.get("error", {}).get("message", "Cloud send failed"))

    message_id = str(data.get("messages", [{}])[0].get("id", f"meta-{datetime.utcnow().timestamp()}"))
    return {"ok": True, "mode": "template" if body.templateName else "text", "messageId": message_id, "to": to, "phoneNumberId": conn["phone_number_id"], "templateName": body.templateName, "languageCode": body.languageCode, "idempotencyKeyUsed": bool(effective_key)}




# ── Meta WABA Templates (from Graph API) ─────────────────────────────

@router.get("/meta/waba-templates")
def list_waba_templates(
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    """Fetch WhatsApp Business templates using the WA Cloud System User token."""
    import httpx, json as _json
    company_id = payload.get("companyId")

    # Get WA Cloud access token + WABA ID from company_runtime_settings / meta_connections
    access_token = None
    waba_id = None

    # Primary: WA Cloud system user token from company_runtime_settings
    try:
        row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
            {"cid": company_id}
        ).mappings().first()
        if row and row["settings_json"]:
            s = row["settings_json"] if isinstance(row["settings_json"], dict) else _json.loads(row["settings_json"])
            access_token = s.get("waCloudAccessToken")
    except Exception:
        pass

    # WABA ID from meta_connections (most reliable source)
    try:
        conn = db.execute(
            text("SELECT waba_id FROM meta_connections WHERE company_id = :cid ORDER BY id DESC LIMIT 1"),
            {"cid": company_id}
        ).mappings().first()
        if conn and conn.get("waba_id"):
            waba_id = conn["waba_id"]
    except Exception:
        pass

    # Fallback: waCloudWabaId from company_runtime_settings (Cloud API without OAuth)
    if not waba_id:
        try:
            row2 = db.execute(
                text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
                {"cid": company_id}
            ).mappings().first()
            if row2 and row2["settings_json"]:
                s2 = row2["settings_json"] if isinstance(row2["settings_json"], dict) else _json.loads(row2["settings_json"])
                waba_id = s2.get("waCloudWabaId") or None
        except Exception:
            pass

    # Auto-discover WABA ID from access token if still missing
    if not waba_id and access_token:
        try:
            disc_resp = httpx.get(
                f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/businesses",
                params={"fields": "id,name,owned_whatsapp_business_accounts{id,name}", "access_token": access_token},
                timeout=10,
            )
            if disc_resp.is_success:
                for biz in disc_resp.json().get("data", []):
                    waba_accounts = (biz.get("owned_whatsapp_business_accounts") or {}).get("data", [])
                    if waba_accounts:
                        waba_id = str(waba_accounts[0]["id"])
                        # Save discovered WABA ID so we don't have to re-discover
                        try:
                            _r3 = db.execute(text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"), {"cid": company_id}).mappings().first()
                            _c3 = {}
                            if _r3 and _r3["settings_json"]:
                                _c3 = _r3["settings_json"] if isinstance(_r3["settings_json"], dict) else _json.loads(_r3["settings_json"])
                            _c3["waCloudWabaId"] = waba_id
                            db.execute(text("INSERT INTO company_runtime_settings (company_id, settings_json, updated_at) VALUES (:cid, :sj, NOW()) ON CONFLICT (company_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()"), {"cid": company_id, "sj": _json.dumps(_c3)})
                            db.commit()
                        except Exception:
                            pass
                        break
        except Exception:
            pass

    if not access_token or not waba_id:
        return {"templates": [], "connected": False, "error": "Falta token de WhatsApp Cloud o WABA ID. Verificá la configuración."}

    resp = httpx.get(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{waba_id}/message_templates",
        params={"access_token": access_token, "limit": 100,
                "fields": "name,status,category,language,components"},
        timeout=15,
    )
    body = resp.json()
    if not resp.is_success or "error" in body:
        err = (body.get("error") or {}).get("message", "Error al obtener templates")
        token_expired = (body.get("error") or {}).get("error_subcode") in (463, 467)
        return {"templates": [], "connected": not token_expired, "error": err, "tokenExpired": token_expired}
    return {"templates": body.get("data", []), "connected": True, "error": None}


@router.get("/meta/selected-template")
def get_selected_template(payload: dict = Depends(get_current_user_payload)):
    """Get the currently selected auto-contact template."""
    s = _get_runtime_settings()
    return {
        "templateName": s.get("metaAutoContactTemplateName", ""),
        "templateLanguage": s.get("metaAutoContactTemplateLanguage", "es_AR"),
    }


@router.put("/meta/selected-template")
def set_selected_template(
    body: dict,
    payload: dict = Depends(get_current_user_payload),
):
    """Save the selected auto-contact template for lead outreach."""
    require_admin(payload)
    name = str(body.get("templateName", "")).strip()
    lang = str(body.get("templateLanguage", "es_AR")).strip()
    _save_runtime_settings({"metaAutoContactTemplateName": name, "metaAutoContactTemplateLanguage": lang})
    return {"ok": True, "templateName": name, "templateLanguage": lang}

# ── Meta Leads Webhook ────────────────────────────────────────────────

def _get_verify_token_for_company(company_id: int, db) -> str:
    """Get verify token from DB for a specific company."""
    try:
        row = db.execute(
            text("SELECT settings_json FROM company_runtime_settings WHERE company_id = :cid LIMIT 1"),
            {"cid": company_id}
        ).mappings().first()
        if row and row["settings_json"]:
            import json as _j
            s = row["settings_json"] if isinstance(row["settings_json"], dict) else _j.loads(row["settings_json"])
            t = s.get("metaLeadAdsWebhookVerifyToken", "")
            if t:
                return str(t)
    except Exception:
        pass
    # fallback to file-based settings
    s = _get_runtime_settings()
    return str(s.get("metaLeadAdsWebhookVerifyToken", ""))


@router.get("/meta-leads/webhook")
def meta_leads_webhook_verify(
    hub_mode: str = Query("", alias="hub.mode"),
    hub_verify_token: str = Query("", alias="hub.verify_token"),
    hub_challenge: str = Query("", alias="hub.challenge"),
    db: Session = Depends(get_db),
):
    s = _get_runtime_settings()
    stored = str(s.get("metaLeadAdsWebhookVerifyToken", ""))
    if hub_mode == "subscribe" and hub_verify_token and hub_verify_token == stored:
        return PlainTextResponse(content=hub_challenge or "ok", status_code=200)
    raise HTTPException(status_code=403, detail="verification_failed")


@router.get("/meta-leads/webhook/{company_id}")
def meta_leads_webhook_verify_company(
    company_id: int,
    hub_mode: str = Query("", alias="hub.mode"),
    hub_verify_token: str = Query("", alias="hub.verify_token"),
    hub_challenge: str = Query("", alias="hub.challenge"),
    db: Session = Depends(get_db),
):
    stored = _get_verify_token_for_company(company_id, db)
    if hub_mode == "subscribe" and hub_verify_token and hub_verify_token == stored:
        return PlainTextResponse(content=hub_challenge or "ok", status_code=200)
    raise HTTPException(status_code=403, detail="verification_failed")


@router.post("/meta-leads/webhook/{company_id}")
async def meta_leads_webhook_company(
    company_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    request.state.company_id = company_id
    return await meta_leads_webhook(request, db)


@router.post("/meta-leads/webhook")
async def meta_leads_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    _ensure_meta_lead_tables(db)
    try:
        body = await request.json()
    except Exception:
        body = {}

    # Resolve company_id from URL path (set by meta_leads_webhook_company) — never default to 1
    resolved_company_id = getattr(request.state, "company_id", None) or body.get("companyId")
    if not resolved_company_id:
        print("[meta-webhook] WARN: no company_id in URL or body, dropping events")
        return {"ok": True, "ingested": False, "events": 0, "results": [], "reason": "no_company"}

    import httpx as _httpx
    company_id = int(resolved_company_id)
    results = []
    ingested_count = 0

    if isinstance(body, dict) and body.get("object") == "page" and isinstance(body.get("entry"), list):
        for entry in body["entry"]:
            page_id = str(entry.get("id", "")).strip()
            for change in entry.get("changes", []):
                if change.get("field") != "leadgen":
                    continue
                value = change.get("value", {})
                leadgen_id = str(value.get("leadgen_id") or value.get("lead", {}).get("id", "")).strip()
                if not leadgen_id:
                    continue

                replay_key = f"{company_id}:{leadgen_id}"
                try:
                    db.execute(text("INSERT INTO meta_lead_replay_guard (replay_key) VALUES (:k)"), {"k": replay_key})
                    db.commit()
                except Exception:
                    db.rollback()
                    results.append({"leadgen_id": leadgen_id, "ok": True, "ingested": False, "reason": "duplicate"})
                    continue

                token_row = db.execute(
                    text("SELECT access_token FROM meta_connections WHERE company_id = :cid AND page_id = :pid ORDER BY id DESC LIMIT 1"),
                    {"cid": company_id, "pid": page_id},
                ).mappings().first()
                if not token_row:
                    print(f"[meta-webhook] no page token for company={company_id} page={page_id}")
                    results.append({"leadgen_id": leadgen_id, "ok": False, "reason": "no_page_token"})
                    continue
                page_token = token_row["access_token"]

                lead_data = None
                try:
                    resp = _httpx.get(
                        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{leadgen_id}",
                        params={
                            "access_token": page_token,
                            "fields": "field_data,form_id,ad_id,campaign_id,adset_id,created_time",
                        },
                        timeout=10,
                    )
                    if resp.status_code == 200:
                        lead_data = resp.json()
                    else:
                        print(f"[meta-webhook] graph {leadgen_id} -> {resp.status_code} {resp.text[:200]}")
                except Exception as e:
                    print(f"[meta-webhook] graph error {leadgen_id}: {e}")

                if not lead_data:
                    results.append({"leadgen_id": leadgen_id, "ok": False, "reason": "graph_no_data"})
                    continue

                fields = {}
                for f in lead_data.get("field_data", []):
                    fname = str(f.get("name", "")).lower().strip()
                    vals = f.get("values") or []
                    if fname and vals:
                        fields[fname] = vals[0]

                contact_phone = str(
                    fields.get("phone_number") or fields.get("phone") or fields.get("telefono") or ""
                ).strip()
                contact_email = str(fields.get("email") or fields.get("correo") or "").strip()
                contact_name = str(
                    fields.get("full_name")
                    or fields.get("name")
                    or fields.get("nombre")
                    or f"{fields.get('first_name', '')} {fields.get('last_name', '')}".strip()
                ).strip()

                db.execute(
                    text(
                        """INSERT INTO meta_lead_events
                        (company_id, page_id, form_id, leadgen_id, ad_id, campaign_id, adset_id,
                         form_fields_json, payload_json, contact_phone, contact_email, contact_name)
                        VALUES (:cid, :pid, :fid, :lid, :aid, :camp, :adset, :ff, :pl, :cp, :ce, :cn)"""
                    ),
                    {
                        "cid": company_id,
                        "pid": page_id,
                        "fid": str(lead_data.get("form_id") or value.get("form_id") or "")[:120],
                        "lid": leadgen_id,
                        "aid": str(lead_data.get("ad_id") or value.get("ad_id") or "")[:120],
                        "camp": str(lead_data.get("campaign_id") or value.get("campaign_id") or "")[:120],
                        "adset": str(lead_data.get("adset_id") or "")[:120],
                        "ff": json.dumps(fields, ensure_ascii=False),
                        "pl": json.dumps(lead_data, ensure_ascii=False),
                        "cp": contact_phone[:60],
                        "ce": contact_email[:160],
                        "cn": (contact_name or "Lead Meta")[:180],
                    },
                )

                if contact_phone or contact_email:
                    existing = None
                    if contact_phone:
                        clean_phone = re.sub(r"\D", "", contact_phone)
                        existing = db.execute(
                            text(
                                r"""SELECT id FROM contacts
                                WHERE "companyId" = :cid
                                AND REGEXP_REPLACE(COALESCE(number,''), '\D', '', 'g') = :phone
                                LIMIT 1"""
                            ),
                            {"cid": company_id, "phone": clean_phone},
                        ).mappings().first()
                    if not existing and contact_email:
                        existing = db.execute(
                            text(
                                'SELECT id FROM contacts WHERE "companyId" = :cid AND LOWER(COALESCE(email,\'\')) = :em LIMIT 1'
                            ),
                            {"cid": company_id, "em": contact_email.lower()},
                        ).mappings().first()
                    if not existing:
                        db.execute(
                            text(
                                """INSERT INTO contacts
                                (name, number, email, source, "leadStatus", "companyId", "createdAt", "updatedAt")
                                VALUES (:n, :ph, :em, 'meta_lead_ads', 'new', :cid, NOW(), NOW())"""
                            ),
                            {
                                "n": (contact_name or "Lead Meta")[:180],
                                "ph": contact_phone or None,
                                "em": contact_email or None,
                                "cid": company_id,
                            },
                        )

                db.commit()
                ingested_count += 1
                results.append({
                    "leadgen_id": leadgen_id,
                    "ok": True,
                    "ingested": True,
                    "name": contact_name,
                    "phone": contact_phone,
                    "email": contact_email,
                })

    return {"ok": True, "ingested": ingested_count > 0, "events": ingested_count, "results": results}


@router.get("/meta-leads/context/{phone}")
def meta_leads_context(
    phone: str,
    payload: dict = Depends(get_current_user_payload),
    db: Session = Depends(get_db),
):
    _ensure_meta_lead_tables(db)
    company_id = payload.get("companyId")
    clean_phone = re.sub(r"\D", "", phone)
    row = db.execute(
        text(r"""SELECT id, form_id, form_name, campaign_id, ad_id, contact_name, contact_email, form_fields_json, created_at
             FROM meta_lead_events
             WHERE company_id = :companyId AND REGEXP_REPLACE(COALESCE(contact_phone,''), '\D', '', 'g') = :phone
             ORDER BY id DESC LIMIT 1"""),
        {"companyId": company_id, "phone": clean_phone},
    ).mappings().first()
    return dict(row) if row else None


# ── Link Preview ──────────────────────────────────────────────────────

@router.get("/link-preview")
async def get_link_preview(
    url: str = Query(""),
    payload: dict = Depends(get_current_user_payload),
):
    """Fetch Open Graph metadata for a URL to show link previews in chat."""
    import httpx
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="url inválida")
    try:
        resp = httpx.get(url, timeout=5, follow_redirects=True, headers={"User-Agent": "Charlott/1.0 LinkPreview"})
        body = resp.text[:50000]
        def _meta(name: str) -> str:
            for attr in (f'property="{name}"', f"property='{name}'", f'name="{name}"', f"name='{name}'"):
                match = re.search(rf'<meta[^>]+{re.escape(attr)}[^>]+content=["\']([^"\']*)["\']', body, re.IGNORECASE)
                if not match:
                    match = re.search(rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+{re.escape(attr)}', body, re.IGNORECASE)
                if match:
                    return match.group(1).strip()
            return ""
        title_match = re.search(r"<title[^>]*>([^<]+)</title>", body, re.IGNORECASE)
        return {
            "url": url,
            "title": _meta("og:title") or (title_match.group(1).strip() if title_match else ""),
            "description": _meta("og:description") or _meta("description"),
            "image": _meta("og:image"),
            "siteName": _meta("og:site_name"),
        }
    except Exception:
        return {"url": url, "title": "", "description": "", "image": "", "siteName": ""}
