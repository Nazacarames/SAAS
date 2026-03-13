import { Router } from "express";
import { QueryTypes } from "sequelize";
import crypto from "crypto";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import sequelize from "../database";
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";
import Message from "../models/Message";
import Whatsapp from "../models/Whatsapp";
import { getRuntimeSettings, saveRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";
import { getWaHardeningMetrics, getWaHardeningAlertSnapshot } from "../services/WhatsAppCloudServices/ProcessCloudWebhookService";
import { getSendHardeningMetrics, getSendHardeningAlertSnapshot } from "../services/MessageServices/SendMessageService";
import { getIntegrationHardeningMetrics, getIntegrationHardeningAlertSnapshot } from "./integrations/integrationRoutes";
import { syncLeadToTokko } from "../services/TokkoServices/TokkoService";
import { normalizeWaPhone } from "../utils/phoneNormalization";
import { getMetaWebhookMetrics, getMetaWebhookAlerts } from "./metaWebhookRoutes";
export const syncLeadStatusToTokko = async (input: any): Promise<any> => {
  try {
    const status = String(input?.status || "").trim().toLowerCase();
    const lossReason = String(input?.lossReason || "").trim();
    const statusLabel = status || "actualizado";
    const detail = lossReason ? ` Motivo: ${lossReason}.` : "";

    return await syncLeadToTokko({
      name: String(input?.name || "").trim(),
      phone: String(input?.phone || "").replace(/\D/g, ""),
      email: String(input?.email || "").trim(),
      source: String(input?.source || "lead-status-sync"),
      message: `Actualización de lead desde CRM: estado=${statusLabel}.${detail}`.slice(0, 500),
      tags: ["status_sync", `crm_${statusLabel}`]
    });
  } catch (err: any) {
    return { ok: false, skipped: false, reason: "status_sync_error", status: null, error: err?.message || String(err) };
  }
};
import CheckInactiveContactsService from "../services/ContactServices/CheckInactiveContactsService";

const aiRoutes = Router();

const resolveOutboundRetryRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any)?.waOutboundRetryRequireIdempotencyKey;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const resolveOutboundIdempotencyKeyMinLength = (): number => {
  const raw = Number((getRuntimeSettings() as any)?.waOutboundIdempotencyKeyMinLength);
  if (!Number.isFinite(raw)) return 8;
  return Math.max(4, Math.min(64, Math.round(raw)));
};

const resolveOutboundRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any)?.waOutboundRequireIdempotencyKey;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const IDEMPOTENCY_KEY_MAX_LENGTH = 120;

const normalizeIdempotencyKey = (raw: string): string => {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_\-.]/g, "")
    .slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
};

const hasInvalidIdempotencyChars = (raw: string): boolean => /[^a-zA-Z0-9:_\-.]/.test(String(raw || "").trim());

const isMonotonicSequence = (value: string): boolean => {
  if (value.length < 6) return false;
  let direction = 0;

  for (let i = 1; i < value.length; i++) {
    const prev = value.charCodeAt(i - 1);
    const curr = value.charCodeAt(i);
    const delta = curr - prev;

    if (delta !== 1 && delta !== -1) return false;
    if (direction === 0) direction = delta;
    if (delta !== direction) return false;
  }

  return true;
};

const isTimestampOnlyIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;
  const compact = normalized.replace(/[:_\-.]/g, "");
  return /^\d{10,17}$/.test(compact);
};

const isWeakIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;
  if (new Set(normalized.split("")).size < 2) return true;

  const compact = normalized.replace(/[:_\-.]/g, "");
  if (isMonotonicSequence(compact)) return true;
  if (/^\d{10,17}$/.test(compact)) return true;

  return false;
};

const resolveWhatsapp = async (companyId: number) => {
  const runtime = getRuntimeSettings();
  const preferredId = Number(runtime.waCloudDefaultWhatsappId || 0);
  if (preferredId > 0) {
    const byId = await Whatsapp.findByPk(preferredId as any);
    if (byId) return byId as any;
  }
  const byDefault = await Whatsapp.findOne({ where: { isDefault: true, companyId } } as any);
  if (byDefault) return byDefault as any;
  const anyWhatsapp = await Whatsapp.findOne({ where: { companyId } } as any);
  if (anyWhatsapp) return anyWhatsapp as any;
  return Whatsapp.create({ name: "WhatsApp Cloud", status: "CONNECTED", isDefault: true, companyId } as any);
};

const parseRetryAfterMs = (retryAfterHeader?: string | null): number | null => {
  if (!retryAfterHeader) return null;
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(retryAfterHeader);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
};

const computeBackoffMs = (attempt: number, retryAfterMs?: number | null) => {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 15000);
  const base = 400 * Math.pow(2, Math.max(0, attempt - 1)); // 400, 800, 1600, ...
  const jitter = Math.floor(Math.random() * 150);
  return base + jitter;
};

const resolveRetryAttempt = (req: any): { retryAttempt: number | null; invalidRaw: string | null } => {
  const candidates = [
    req?.headers?.["x-retry-attempt"],
    req?.headers?.["retry-attempt"],
    req?.body?.retryAttempt
  ];

  let raw: unknown;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || String(candidate).trim() === "") continue;
    raw = Array.isArray(candidate) ? candidate[0] : candidate;
    break;
  }

  if (raw === undefined || raw === null || String(raw).trim() === "") return { retryAttempt: null, invalidRaw: null };

  const normalized = String(raw).trim();
  if (!/^\d+$/.test(normalized)) return { retryAttempt: null, invalidRaw: normalized };

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    return { retryAttempt: null, invalidRaw: normalized };
  }

  return { retryAttempt: parsed, invalidRaw: null };
};

const isRetryableCloudFailure = (status?: number, code?: number) => {
  if (!status) return true;
  if (status === 408 || status === 409 || status === 429) return true;
  if (status >= 500) return true;
  if (code === 131016 || code === 131048 || code === 131056) return true;
  return false;
};

const sendCloudText = async (to: string, text: string) => {
  const settings = getRuntimeSettings();
  if (!settings.waCloudPhoneNumberId || !settings.waCloudAccessToken) throw new Error("Cloud API credentials missing");

  const maxAttempts = Math.max(1, Math.min(6, Number(settings.waOutboundRetryMaxAttempts || 3)));
  let lastError = "Cloud send failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(`https://graph.facebook.com/v21.0/${settings.waCloudPhoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.waCloudAccessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
      });

      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok) return data?.messages?.[0]?.id || `meta-${Date.now()}`;

      const cloudCode = Number(data?.error?.code);
      lastError = data?.error?.message || `Cloud send failed (${resp.status})`;
      if (!isRetryableCloudFailure(resp.status, cloudCode) || attempt === maxAttempts) {
        throw new Error(lastError);
      }

      const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, computeBackoffMs(attempt, retryAfterMs)));
    } catch (error: any) {
      const status = Number(error?.statusCode || error?.status || 0) || undefined;
      if (!isRetryableCloudFailure(status) || attempt === maxAttempts) {
        throw error;
      }
      const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.["retry-after"] || error?.headers?.["retry-after"] || null);
      lastError = error?.message || lastError;
      await new Promise((resolve) => setTimeout(resolve, computeBackoffMs(attempt, retryAfterMs)));
    }
  }

  throw new Error(lastError);
};

const graphApiVersion = process.env.META_GRAPH_API_VERSION || "v21.0";
const metaOauthClientId = process.env.META_APP_ID || process.env.META_CLIENT_ID || "";
const metaOauthClientSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET || "";
const metaOauthRedirectUri = process.env.META_OAUTH_REDIRECT_URI || "";
const metaOauthStateSecret = process.env.META_OAUTH_STATE_SECRET || process.env.JWT_SECRET || "dev-meta-oauth-secret";

const getMetaOauthConfig = (req?: any) => {
  const runtime: any = getRuntimeSettings();
  const clientId = String(metaOauthClientId || runtime?.metaLeadAdsAppId || '').trim();
  const clientSecret = String(metaOauthClientSecret || runtime?.metaLeadAdsAppSecret || '').trim();
  const redirectUri = String(
    metaOauthRedirectUri ||
      runtime?.metaOauthRedirectUri ||
      `https://${req?.get?.('host') || 'login.charlott.ai'}/api/ai/meta/oauth/callback`
  ).trim();
  return { clientId, clientSecret, redirectUri };
};

let metaOauthTablesReady = false;
const ensureMetaOauthTables = async () => {
  if (metaOauthTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_oauth_states (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    user_id INTEGER,
    nonce VARCHAR(120) NOT NULL,
    state_hash VARCHAR(120) NOT NULL UNIQUE,
    redirect_after VARCHAR(700),
    status VARCHAR(40) NOT NULL DEFAULT 'pending',
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
  )`);

  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_connections (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    meta_business_id VARCHAR(120),
    waba_id VARCHAR(120),
    phone_number_id VARCHAR(120),
    phone_number_display VARCHAR(120),
    access_token TEXT NOT NULL,
    token_type VARCHAR(40),
    token_expires_at TIMESTAMP WITH TIME ZONE,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    webhook_verified_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(40) NOT NULL DEFAULT 'connected',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);

  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_meta_connections_company ON meta_connections(company_id, id DESC)`);
  metaOauthTablesReady = true;
};

const signMetaState = (payload: string) =>
  crypto.createHmac("sha256", metaOauthStateSecret).update(payload).digest("hex").slice(0, 32);

const sendCloudTextWithCredentials = async (phoneNumberId: string, accessToken: string, to: string, text: string, idempotencyKey?: string) => {
  const resp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {})
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Cloud send failed (${resp.status})`);
  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const sendCloudTemplateWithCredentials = async (
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode = 'en',
  idempotencyKey?: string,
  templateVariables?: string[]
) => {
  const resp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {})
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        // Only send body parameters — sending a 'header' component for templates
        // that don't have one causes a Meta API error (code 132000).
        ...(Array.isArray(templateVariables) && templateVariables.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  parameters: templateVariables.map((v) => ({ type: 'text', text: String(v || '') }))
                }
              ]
            }
          : {})
      }
    })
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Cloud template send failed (${resp.status})`);
  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const resolveMetaFormName = async (companyId: number, formId: string): Promise<string> => {
  const cleanFormId = String(formId || '').trim();
  if (!cleanFormId) return '';

  try {
    const [conn]: any = await sequelize.query(
      `SELECT access_token FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1`,
      { replacements: { companyId }, type: QueryTypes.SELECT }
    );
    const accessToken = String(conn?.access_token || '').trim();
    if (!accessToken) return '';

    const resp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${cleanFormId}?fields=name`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) return '';

    return String(data?.name || '').trim();
  } catch {
    return '';
  }
};

const scoreFromText = (text: string, current = 0) => {
  let score = Number(current || 0);
  if (/comprar|contratar|precio|plan|cotiz|demo/i.test(text)) score = Math.max(score, 65);
  if (/urgente|hoy|ahora|ya/i.test(text)) score = Math.max(score, 78);
  if (/presupuesto|interesa|quiero/i.test(text)) score = Math.max(score, 72);
  if (/gracias|resuelto|listo/i.test(text)) score = Math.max(score, 45);
  return Math.min(100, score);
};

const buildHolaTemplatePreview = (rawName?: string): string => {
  const firstName = String(rawName || '').trim().split(/\s+/)[0];
  return firstName ? `¡Hola ${firstName}! 👋 Soy el asistente virtual. ¿En qué te puedo ayudar?` : '¡Hola! 👋 Soy el asistente virtual. ¿En qué te puedo ayudar?';
};

const inferLeadStatusByBotSignals = ({ text, leadScore, currentStatus }: { text: string; leadScore: number; currentStatus?: string }): string => {
  const t = String(text || "").toLowerCase();
  const curr = String(currentStatus || "").toLowerCase().trim();

  if (/reserva|seña|senia|cerrar|firma|boleto|avanzamos|quiero avanzar|quiero cerrar/i.test(t)) return "cierre";
  if (/enviar propuesta|te envío propuesta|propuesta|cotización|cotizacion|financiación|financiacion|plan de pago/i.test(t)) return "propuesta";
  if (/visita|tour|recorrido|agendar|agenda|llamar|llamada|reunión|reunion|cuando puedo ir/i.test(t)) return "calificacion";
  if (/hola|buenas|info|información|informacion|consulta|me interesa|quiero saber/i.test(t)) return "primer_contacto";
  if (/dejalo|después|despues|más tarde|mas tarde|no ahora/i.test(t)) return "esperando_respuesta";

  if (leadScore >= 85) return "cierre";
  if (leadScore >= 65) return "propuesta";
  if (leadScore >= 40) return "calificacion";
  if (leadScore >= 20) return "primer_contacto";

  return curr || "nuevo_ingreso";
};

const CRITICAL_HARDENING_ALERT_SIGNALS = new Set([
  "outbound_retry_exhausted",
  "inbound_signature_invalid_blocked",
  "inbound_payload_replay_blocked",
  "outbound_provider_failure_rate_high",
  "outbound_provider_conflict_rate_high",
  "outbound_dedupe_fail_closed_blocked", 
  "outbound_dedupe_emergency_mode_active",
  "outbound_integration_retry_without_idempotency_key_rate_high",
  "outbound_integration_retry_idempotency_key_required_blocked"
]);

const normalizeHardeningAlertSeverity = (alert: any): "critical" | "warn" => {
  const explicit = String(alert?.severity || "").toLowerCase();
  if (explicit === "critical" || explicit === "warn") return explicit as "critical" | "warn";

  const signal = String(alert?.signal || "");
  if (CRITICAL_HARDENING_ALERT_SIGNALS.has(signal)) return "critical";

  const inWindow = Number(alert?.inWindow || 0);
  const threshold = Number(alert?.threshold || 0);
  if (Number.isFinite(inWindow) && Number.isFinite(threshold) && threshold > 0 && inWindow >= threshold * 2) {
    return "critical";
  }

  return "warn";
};

aiRoutes.get("/hardening/wa-cloud", isAuth, isAdmin, async (req: any, res) => {
  try {
    const inbound = {
      metrics: getWaHardeningMetrics(),
      alerts: getWaHardeningAlertSnapshot()
    };
    const outbound = {
      metrics: getSendHardeningMetrics(),
      alerts: getSendHardeningAlertSnapshot()
    };
    const integrationApi = {
      metrics: getIntegrationHardeningMetrics(),
      alerts: getIntegrationHardeningAlertSnapshot()
    };
    const metaWebhook = {
      metrics: getMetaWebhookMetrics(),
      alerts: getMetaWebhookAlerts()
    };

    const pendingAlerts = [
      ...(Array.isArray(inbound.alerts?.pendingAlerts) ? inbound.alerts.pendingAlerts : []),
      ...(Array.isArray(outbound.alerts?.pendingAlerts) ? outbound.alerts.pendingAlerts : []),
      ...(Array.isArray(integrationApi.alerts?.pendingAlerts) ? integrationApi.alerts.pendingAlerts : []),
      ...(Array.isArray(metaWebhook.alerts)
        ? metaWebhook.alerts.map((alert: any) => ({
            ...alert,
            signal: String(alert?.signal || alert?.key || "meta_webhook_alert")
          }))
        : [])
    ].map((alert: any) => ({
      ...alert,
      severity: normalizeHardeningAlertSeverity(alert)
    }));

    const pendingAlertCount = pendingAlerts.length;
    const pendingCriticalCount = pendingAlerts.filter((alert: any) => String(alert?.severity || "").toLowerCase() === "critical").length;
    const status = pendingCriticalCount > 0 ? "critical" : pendingAlertCount > 0 ? "warn" : "ok";
    const failOnAlert = ["1", "true", "yes", "on"].includes(String(req.query?.failOnAlert || "").toLowerCase());
    const statusCode = failOnAlert && pendingAlertCount > 0 ? 503 : 200;

    return res.status(statusCode).json({
      ok: pendingAlertCount === 0,
      generatedAt: new Date().toISOString(),
      hardening: {
        status,
        pendingAlertCount,
        failOnAlert,
        pendingCriticalCount,
        inbound,
        outbound,
        integrationApi,
        metaWebhook
      }
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "wa hardening snapshot failed" });
  }
});

aiRoutes.get("/agents", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const agents = await sequelize.query(
    `SELECT * FROM ai_agents WHERE company_id = :companyId ORDER BY id DESC`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return res.json(agents);
});

aiRoutes.post("/agents", isAuth, isAdmin, async (req: any, res) => {
  const { companyId } = req.user;
  const {
    name,
    persona,
    language = "es",
    model = "gpt-4o-mini",
    temperature = 0.3,
    maxTokens = 600,
    isActive = true,
    welcomeMsg = "",
    offhoursMsg = "",
    farewellMsg = "",
    businessHoursJson = "{}",
    funnelStagesJson = "[\"Nuevo\",\"Contactado\",\"Calificado\",\"Interesado\"]"
  } = req.body || {};

  const [row]: any = await sequelize.query(
    `INSERT INTO ai_agents
      (company_id, name, persona, language, model, temperature, max_tokens, is_active, welcome_msg, offhours_msg, farewell_msg, business_hours_json, funnel_stages_json, created_at, updated_at)
     VALUES
      (:companyId, :name, :persona, :language, :model, :temperature, :maxTokens, :isActive, :welcomeMsg, :offhoursMsg, :farewellMsg, :businessHoursJson, :funnelStagesJson, NOW(), NOW())
     RETURNING *`,
    {
      replacements: {
        companyId,
        name,
        persona,
        language,
        model,
        temperature,
        maxTokens,
        isActive,
        welcomeMsg,
        offhoursMsg,
        farewellMsg,
        businessHoursJson,
        funnelStagesJson
      },
      type: QueryTypes.INSERT
    }
  );

  return res.status(201).json(row);
});

aiRoutes.put("/agents/:id", isAuth, isAdmin, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;
  const fields = req.body || {};

  await sequelize.query(
    `UPDATE ai_agents
     SET
      name = COALESCE(:name, name),
      persona = COALESCE(:persona, persona),
      language = COALESCE(:language, language),
      model = COALESCE(:model, model),
      temperature = COALESCE(:temperature, temperature),
      max_tokens = COALESCE(:maxTokens, max_tokens),
      is_active = COALESCE(:isActive, is_active),
      welcome_msg = COALESCE(:welcomeMsg, welcome_msg),
      offhours_msg = COALESCE(:offhoursMsg, offhours_msg),
      farewell_msg = COALESCE(:farewellMsg, farewell_msg),
      business_hours_json = COALESCE(:businessHoursJson, business_hours_json),
      funnel_stages_json = COALESCE(:funnelStagesJson, funnel_stages_json),
      updated_at = NOW()
     WHERE id = :id AND company_id = :companyId`,
    {
      replacements: {
        id: Number(id),
        companyId,
        name: fields.name ?? null,
        persona: fields.persona ?? null,
        language: fields.language ?? null,
        model: fields.model ?? null,
        temperature: fields.temperature ?? null,
        maxTokens: fields.maxTokens ?? null,
        isActive: fields.isActive ?? null,
        welcomeMsg: fields.welcomeMsg ?? null,
        offhoursMsg: fields.offhoursMsg ?? null,
        farewellMsg: fields.farewellMsg ?? null,
        businessHoursJson: fields.businessHoursJson ?? null,
        funnelStagesJson: fields.funnelStagesJson ?? null
      },
      type: QueryTypes.UPDATE
    }
  );

  const [agent]: any = await sequelize.query(
    `SELECT * FROM ai_agents WHERE id = :id AND company_id = :companyId`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  return res.json(agent || null);
});

aiRoutes.post("/tickets/:ticketId/toggle-bot", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { ticketId } = req.params;
  const { botEnabled, humanOverride } = req.body || {};

  await sequelize.query(
    `UPDATE tickets
     SET bot_enabled = COALESCE(:botEnabled, bot_enabled),
         human_override = COALESCE(:humanOverride, human_override),
         "updatedAt" = NOW()
     WHERE id = :ticketId AND "companyId" = :companyId`,
    {
      replacements: {
        ticketId: Number(ticketId),
        companyId,
        botEnabled: typeof botEnabled === "boolean" ? botEnabled : null,
        humanOverride: typeof humanOverride === "boolean" ? humanOverride : null
      },
      type: QueryTypes.UPDATE
    }
  );

  const [ticket]: any = await sequelize.query(
    `SELECT id, status, bot_enabled, human_override FROM tickets WHERE id = :ticketId`,
    { replacements: { ticketId: Number(ticketId) }, type: QueryTypes.SELECT }
  );

  return res.json(ticket || null);
});

aiRoutes.post("/kb/documents", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { title, category = "faq", content = "" } = req.body || {};

  const [doc]: any = await sequelize.query(
    `INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
     VALUES (:companyId, :title, :category, 'manual', 'ready', :content, NOW(), NOW())
     RETURNING *`,
    { replacements: { companyId, title, category, content }, type: QueryTypes.INSERT }
  );

  // simple chunking by paragraphs
  const parts = String(content)
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 200);

  for (let i = 0; i < parts.length; i++) {
    await sequelize.query(
      `INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
       VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())`,
      {
        replacements: {
          documentId: doc.id,
          chunkIndex: i,
          chunkText: parts[i],
          tokenCount: Math.max(1, Math.floor(parts[i].length / 4))
        },
        type: QueryTypes.INSERT
      }
    );
  }

  return res.status(201).json({ document: doc, chunksCreated: parts.length });
});

aiRoutes.put("/kb/documents/:id", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;
  const { title, category, content } = req.body || {};

  const [existing]: any = await sequelize.query(
    `SELECT id, title, category, content
     FROM kb_documents
     WHERE id = :id AND company_id = :companyId
     LIMIT 1`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  if (!existing) return res.status(404).json({ error: "Documento no encontrado" });

  const nextTitle = typeof title === "string" ? title : existing.title;
  const nextCategory = typeof category === "string" ? category : existing.category;
  const nextContent = typeof content === "string" ? content : existing.content;

  await sequelize.query(
    `UPDATE kb_documents
     SET title = :title,
         category = :category,
         content = :content,
         updated_at = NOW()
     WHERE id = :id AND company_id = :companyId`,
    {
      replacements: {
        id: Number(id),
        companyId,
        title: nextTitle,
        category: nextCategory,
        content: nextContent
      },
      type: QueryTypes.UPDATE
    }
  );

  await sequelize.query(
    `DELETE FROM kb_chunks WHERE document_id = :documentId`,
    { replacements: { documentId: Number(id) }, type: QueryTypes.DELETE }
  );

  const parts = String(nextContent)
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 200);

  for (let i = 0; i < parts.length; i++) {
    await sequelize.query(
      `INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
       VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())`,
      {
        replacements: {
          documentId: Number(id),
          chunkIndex: i,
          chunkText: parts[i],
          tokenCount: Math.max(1, Math.floor(parts[i].length / 4))
        },
        type: QueryTypes.INSERT
      }
    );
  }

  const [updated]: any = await sequelize.query(
    `SELECT d.id, d.title, d.category, d.status, d.source_type, d.created_at, d.updated_at,
            COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
     FROM kb_documents d
     WHERE d.id = :id AND d.company_id = :companyId
     LIMIT 1`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  return res.json({ ok: true, document: updated || null, chunksCreated: parts.length });
});

aiRoutes.delete("/kb/documents/:id", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;

  const [existing]: any = await sequelize.query(
    `SELECT id FROM kb_documents WHERE id = :id AND company_id = :companyId LIMIT 1`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  if (!existing) return res.status(404).json({ error: "Documento no encontrado" });

  await sequelize.query(
    `DELETE FROM kb_chunks WHERE document_id = :documentId`,
    { replacements: { documentId: Number(id) }, type: QueryTypes.DELETE }
  );

  await sequelize.query(
    `DELETE FROM kb_documents WHERE id = :id AND company_id = :companyId`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.DELETE }
  );

  return res.json({ ok: true, deletedId: Number(id) });
});

aiRoutes.post("/rag/search", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { query = "", limit = 5 } = req.body || {};

  const rows = await sequelize.query(
    `SELECT c.id, c.document_id, c.chunk_text, d.title, d.category,
            (CASE WHEN POSITION(LOWER(:query) IN LOWER(c.chunk_text)) > 0 THEN 0.95 ELSE 0.50 END) AS score
     FROM kb_chunks c
     JOIN kb_documents d ON d.id = c.document_id
     WHERE d.company_id = :companyId
       AND (LOWER(c.chunk_text) LIKE LOWER(:qLike) OR LOWER(d.title) LIKE LOWER(:qLike))
     ORDER BY score DESC, c.id DESC
     LIMIT :limit`,
    {
      replacements: {
        companyId,
        query: String(query),
        qLike: `%${String(query)}%`,
        limit: Number(limit) || 5
      },
      type: QueryTypes.SELECT
    }
  );

  await sequelize.query(
    `INSERT INTO kb_search_logs (company_id, query, top_k, results_json, created_at, updated_at)
     VALUES (:companyId, :query, :topK, :resultsJson, NOW(), NOW())`,
    {
      replacements: {
        companyId,
        query: String(query),
        topK: Number(limit) || 5,
        resultsJson: JSON.stringify(rows)
      },
      type: QueryTypes.INSERT
    }
  );

  return res.json(rows);
});

aiRoutes.get("/kb/documents", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { q = "", category = "", status = "" } = req.query || {};

  const where: string[] = ["d.company_id = :companyId"];
  const replacements: any = { companyId };

  if (String(q || "").trim()) {
    where.push("(LOWER(d.title) LIKE LOWER(:qLike) OR LOWER(d.content) LIKE LOWER(:qLike))");
    replacements.qLike = `%${String(q).trim()}%`;
  }
  if (String(category || "").trim()) {
    where.push("d.category = :category");
    replacements.category = String(category).trim();
  }
  if (String(status || "").trim()) {
    where.push("d.status = :status");
    replacements.status = String(status).trim();
  }

  const rows = await sequelize.query(
    `SELECT d.id, d.title, d.category, d.status, d.source_type, d.content, d.created_at, d.updated_at,
            COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
     FROM kb_documents d
     WHERE ${where.join(" AND ")}
     ORDER BY d.id DESC
     LIMIT 500`,
    { replacements, type: QueryTypes.SELECT }
  );

  return res.json(rows);
});

aiRoutes.get("/kb/stats", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const [row]: any = await sequelize.query(
    `SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END)::int AS synced,
      SUM(CASE WHEN status <> 'ready' THEN 1 ELSE 0 END)::int AS pending,
      COUNT(DISTINCT category)::int AS categories
     FROM kb_documents
     WHERE company_id = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  return res.json(row || { total: 0, synced: 0, pending: 0, categories: 0 });
});

aiRoutes.get("/appointments", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { from = "", to = "" } = req.query || {};

  const where: string[] = ["a.company_id = :companyId"];
  const replacements: any = { companyId };

  if (String(from || "").trim()) {
    where.push("a.starts_at >= :from");
    replacements.from = String(from).trim();
  }
  if (String(to || "").trim()) {
    where.push("a.starts_at <= :to");
    replacements.to = String(to).trim();
  }

  const rows = await sequelize.query(
    `SELECT a.*, c.name AS contact_name, c.number AS contact_number
     FROM appointments a
     JOIN contacts c ON c.id = a.contact_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.starts_at ASC
     LIMIT 500`,
    { replacements, type: QueryTypes.SELECT }
  );

  return res.json(rows);
});

aiRoutes.get("/funnel/stats", isAuth, async (req: any, res) => {
  const { companyId } = req.user;

  const [row]: any = await sequelize.query(
    `SELECT
      SUM(CASE WHEN COALESCE(c.lead_score,0) < 25 THEN 1 ELSE 0 END)::int AS nuevo,
      SUM(CASE WHEN COALESCE(c.lead_score,0) >= 25 AND COALESCE(c.lead_score,0) < 50 THEN 1 ELSE 0 END)::int AS contactado,
      SUM(CASE WHEN COALESCE(c.lead_score,0) >= 50 AND COALESCE(c.lead_score,0) < 75 THEN 1 ELSE 0 END)::int AS calificado,
      SUM(CASE WHEN COALESCE(c.lead_score,0) >= 75 THEN 1 ELSE 0 END)::int AS interesado
     FROM contacts c
     WHERE c."companyId" = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  return res.json(row || { nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });
});

aiRoutes.get(['/reports/attribution', '/reports/leads'], isAuth, async (req: any, res) => {
  await ensureMetaLeadTables();
  const { companyId } = req.user;
  const { from = '', to = '', source = '', campaign = '', form = '' } = req.query || {};

  const where: string[] = ['company_id = :companyId'];
  const replacements: any = { companyId };

  // Exclude structurally invalid historical rows (no recoverable contact data),
  // so funnel/reporting reflects real leads instead of malformed/test payloads.
  where.push(`(
    COALESCE(leadgen_id,'') <> ''
    AND (
      NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), '') IS NOT NULL
      OR COALESCE(contact_email,'') <> ''
      OR COALESCE(contact_name,'') <> ''
      OR COALESCE(form_fields_json,'') NOT IN ('','{}','[]')
    )
  )`);

  if (String(from || '').trim()) {
    where.push('created_at >= :from');
    replacements.from = String(from).trim();
  }
  if (String(to || '').trim()) {
    where.push("created_at < (:to::date + INTERVAL '1 day')");
    replacements.to = String(to).trim();
  }
  if (String(source || '').trim()) {
    where.push('source = :source');
    replacements.source = String(source).trim();
  }
  if (String(campaign || '').trim()) {
    where.push('LOWER(COALESCE(campaign_id,\'\')) LIKE LOWER(:campaign)');
    replacements.campaign = `%${String(campaign).trim()}%`;
  }
  if (String(form || '').trim()) {
    where.push(`(LOWER(COALESCE(form_name,'')) LIKE LOWER(:form) OR LOWER(COALESCE(form_id,'')) LIKE LOWER(:form))`);
    replacements.form = `%${String(form).trim()}%`;
  }

  const baseWhere = where.join(' AND ');

  // Backfill liviano: resolver nombre de formulario para eventos históricos que solo tienen form_id
  // + intentar completar datos de contacto cuando llegó leadgen_id pero faltaron field_data por fallo transitorio en Graph.
  try {
    const missingForms: any[] = await sequelize.query(
      `SELECT DISTINCT form_id
       FROM meta_lead_events
       WHERE company_id = :companyId
         AND COALESCE(form_id,'') <> ''
         AND COALESCE(form_name,'') = ''
       ORDER BY form_id ASC
       LIMIT 20`,
      { replacements: { companyId }, type: QueryTypes.SELECT }
    );

    for (const row of missingForms || []) {
      const formId = String(row?.form_id || '').trim();
      if (!formId) continue;
      const resolvedName = await resolveMetaFormName(companyId, formId);
      if (!resolvedName) continue;

      await sequelize.query(
        `UPDATE meta_lead_events
         SET form_name = :formName, updated_at = NOW()
         WHERE company_id = :companyId
           AND form_id = :formId
           AND COALESCE(form_name,'') = ''`,
        {
          replacements: { companyId, formId, formName: resolvedName },
          type: QueryTypes.UPDATE
        }
      );
    }

    const missingLeadDetails: any[] = await sequelize.query(
      `SELECT id, leadgen_id
       FROM meta_lead_events
       WHERE company_id = :companyId
         AND COALESCE(leadgen_id,'') <> ''
         AND COALESCE(contact_name,'') = ''
         AND COALESCE(contact_email,'') = ''
         AND NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), '') IS NULL
       ORDER BY id DESC
       LIMIT 25`,
      { replacements: { companyId }, type: QueryTypes.SELECT }
    );

    for (const row of missingLeadDetails || []) {
      const eventId = Number(row?.id || 0);
      const leadgenId = String(row?.leadgen_id || '').trim();
      if (!eventId || !leadgenId) continue;

      const leadDetails = await fetchLeadgenDetails(companyId, leadgenId);
      if (!leadDetails?.id) continue;

      const fd = Array.isArray(leadDetails?.field_data) ? leadDetails.field_data : [];
      const findField = (name: string) => {
        const hit = fd.find((x: any) => String(x?.name || '').toLowerCase() === name.toLowerCase());
        return String(hit?.values?.[0] || '').trim();
      };

      const phone = findField('phone_number') || findField('telefono');
      const email = findField('email');
      const name = findField('full_name') || findField('nombre');

      await sequelize.query(
        `UPDATE meta_lead_events
         SET form_fields_json = CASE WHEN COALESCE(form_fields_json,'') = '' OR form_fields_json = '{}' THEN :formFieldsJson ELSE form_fields_json END,
             contact_phone = CASE WHEN COALESCE(contact_phone,'') = '' THEN :phone ELSE contact_phone END,
             contact_email = CASE WHEN COALESCE(contact_email,'') = '' THEN :email ELSE contact_email END,
             contact_name = CASE WHEN COALESCE(contact_name,'') = '' THEN :name ELSE contact_name END,
             updated_at = NOW()
         WHERE id = :eventId AND company_id = :companyId`,
        {
          replacements: {
            eventId,
            companyId,
            formFieldsJson: JSON.stringify(fd || {}),
            phone,
            email,
            name
          },
          type: QueryTypes.UPDATE
        }
      );
    }
  } catch {
    // no-op: no interrumpir reportes por backfill
  }

  const [summary]: any = await sequelize.query(
    `SELECT
      COUNT(*)::int AS total_leads,
      COUNT(DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), ''))::int AS unique_phones,
      COUNT(DISTINCT NULLIF(COALESCE(campaign_id,''), ''))::int AS campaigns,
      COUNT(DISTINCT NULLIF(COALESCE(form_id,''), ''))::int AS forms
     FROM meta_lead_events
     WHERE ${baseWhere}`,
    { replacements, type: QueryTypes.SELECT }
  );

  const [lifecycle]: any = await sequelize.query(
    `WITH ev AS (
      SELECT *
      FROM meta_lead_events
      WHERE ${baseWhere}
    )
    SELECT
      COUNT(*)::int AS received_events,
      SUM(CASE WHEN NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''), '\\D', '', 'g'), '') IS NULL THEN 1 ELSE 0 END)::int AS no_phone,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM contacts c
        WHERE c."companyId" = ev.company_id
          AND (
            NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g'), '') = NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''), '\\D', '', 'g'), '')
            OR LOWER(NULLIF(COALESCE(c.email,''), '')) = LOWER(NULLIF(COALESCE(ev.contact_email,''), ''))
          )
      ) THEN 1 ELSE 0 END)::int AS converted_contacts,
      SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM contacts c
        JOIN tickets t ON t."contactId" = c.id AND t."companyId" = ev.company_id
        WHERE c."companyId" = ev.company_id
          AND (
            NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g'), '') = NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''), '\\D', '', 'g'), '')
            OR LOWER(NULLIF(COALESCE(c.email,''), '')) = LOWER(NULLIF(COALESCE(ev.contact_email,''), ''))
          )
      ) THEN 1 ELSE 0 END)::int AS with_conversation
    FROM ev`,
    { replacements, type: QueryTypes.SELECT }
  );

  const receivedEvents = Number(lifecycle?.received_events || 0);
  const convertedContacts = Number(lifecycle?.converted_contacts || 0);
  const withConversation = Number(lifecycle?.with_conversation || 0);
  const noPhone = Number(lifecycle?.no_phone || 0);
  const notConverted = Math.max(0, receivedEvents - convertedContacts);

  const lifecycleBreakdown = [
    { key: 'received_events', label: 'Eventos recibidos', value: receivedEvents },
    { key: 'converted_contacts', label: 'Convertidos a contacto', value: convertedContacts },
    { key: 'not_converted', label: 'No convertidos', value: notConverted },
    { key: 'with_conversation', label: 'Con conversación', value: withConversation },
    { key: 'no_phone', label: 'Sin teléfono', value: noPhone }
  ];

  const bySource = await sequelize.query(
    `SELECT COALESCE(NULLIF(source,''), 'unknown') AS source, COUNT(*)::int AS leads
     FROM meta_lead_events
     WHERE ${baseWhere}
     GROUP BY COALESCE(NULLIF(source,''), 'unknown')
     ORDER BY leads DESC
     LIMIT 20`,
    { replacements, type: QueryTypes.SELECT }
  );

  const byCampaign = await sequelize.query(
    `SELECT COALESCE(NULLIF(campaign_id,''), 'unknown') AS campaign, COUNT(*)::int AS leads
     FROM meta_lead_events
     WHERE ${baseWhere}
     GROUP BY COALESCE(NULLIF(campaign_id,''), 'unknown')
     ORDER BY leads DESC
     LIMIT 30`,
    { replacements, type: QueryTypes.SELECT }
  );

  const byFormRaw: any[] = await sequelize.query(
    `SELECT NULLIF(COALESCE(form_id,''), '') AS form_id,
            NULLIF(COALESCE(form_name,''), '') AS form_name,
            COUNT(*)::int AS leads
     FROM meta_lead_events
     WHERE ${baseWhere}
     GROUP BY NULLIF(COALESCE(form_id,''), ''), NULLIF(COALESCE(form_name,''), '')
     ORDER BY leads DESC
     LIMIT 30`,
    { replacements, type: QueryTypes.SELECT }
  );

  const byForm = [] as any[];
  for (const row of byFormRaw || []) {
    const formId = String(row?.form_id || '').trim();
    let formName = String(row?.form_name || '').trim();

    if (!formName && formId) {
      formName = await resolveMetaFormName(companyId, formId);
      if (formName) {
        await sequelize.query(
          `UPDATE meta_lead_events
           SET form_name = :formName, updated_at = NOW()
           WHERE company_id = :companyId
             AND form_id = :formId
             AND COALESCE(form_name,'') = ''`,
          {
            replacements: { companyId, formId, formName },
            type: QueryTypes.UPDATE
          }
        );
      }
    }

    byForm.push({
      form: formName || formId || 'unknown',
      formId: formId || null,
      formName: formName || null,
      leads: Number(row?.leads || 0)
    });
  }

  const timeline = await sequelize.query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS leads
     FROM meta_lead_events
     WHERE ${baseWhere}
     GROUP BY created_at::date
     ORDER BY day DESC
     LIMIT 31`,
    { replacements, type: QueryTypes.SELECT }
  );

  return res.json({
    summary: {
      ...(summary || { total_leads: 0, unique_phones: 0, campaigns: 0, forms: 0 }),
      received_events: receivedEvents,
      converted_contacts: convertedContacts,
      not_converted: notConverted,
      with_conversation: withConversation,
      no_phone: noPhone
    },
    lifecycleBreakdown,
    bySource,
    byCampaign,
    byForm,
    timeline
  });
});

const TOOL_MANIFEST = [
  {
    name: "upsert_contact",
    description: "Crea o actualiza un contacto por número",
    requiredArgs: ["number"],
    optionalArgs: ["name", "email", "businessType", "needs", "leadScore"]
  },
  {
    name: "agendar_cita",
    description: "Agenda una cita para un contacto",
    requiredArgs: ["contactId", "startsAt"],
    optionalArgs: ["durationMin", "ticketId", "serviceType", "notes"]
  },
  {
    name: "reprogramar_cita",
    description: "Reprograma una cita existente",
    requiredArgs: ["appointmentId", "startsAt"],
    optionalArgs: ["durationMin", "reason"]
  },
  {
    name: "cancelar_cita",
    description: "Cancela una cita existente",
    requiredArgs: ["appointmentId"],
    optionalArgs: ["reason"]
  },
  {
    name: "consultar_conocimiento",
    description: "Busca fragmentos relevantes en la base de conocimiento",
    requiredArgs: ["query"],
    optionalArgs: []
  },
  {
    name: "actualizar_lead_score",
    description: "Actualiza score y estado del lead",
    requiredArgs: [],
    optionalArgs: ["contactId", "ticketId", "leadScore", "inboundText", "text"]
  },
  {
    name: "agregar_nota",
    description: "Agrega una nota operativa asociada a ticket",
    requiredArgs: ["ticketId", "note"],
    optionalArgs: []
  }
];

aiRoutes.get("/tools/manifest", isAuth, async (_req: any, res) => {
  return res.json({ ok: true, tools: TOOL_MANIFEST });
});

aiRoutes.get("/mcp/tools", isAuth, async (_req: any, res) => {
  return res.json({ ok: true, tools: TOOL_MANIFEST, protocol: "mcp-like" });
});

aiRoutes.post("/tools/execute", isAuth, async (req: any, res) => {
  const { companyId, id: userId } = req.user;
  const { tool, args = {} } = req.body || {};

  const fail = (error: string, status = 400) => res.status(status).json({ ok: false, error });

  try {
    if (tool === "upsert_contact") {
      const number = String(args.number || "").replace(/\D/g, "");
      if (!number) return fail("number requerido");

      const [existing]: any = await sequelize.query(
        `SELECT * FROM contacts WHERE "companyId" = :companyId AND number = :number LIMIT 1`,
        { replacements: { companyId, number }, type: QueryTypes.SELECT }
      );

      if (existing) {
        await sequelize.query(
          `UPDATE contacts
           SET name = COALESCE(:name, name),
               email = COALESCE(:email, email),
               business_type = COALESCE(:businessType, business_type),
               needs = COALESCE(:needs, needs),
               updatedAt = NOW()
           WHERE id = :id`,
          {
            replacements: {
              id: existing.id,
              name: args.name ?? null,
              email: args.email ?? null,
              businessType: args.businessType ?? null,
              needs: args.needs ?? null
            },
            type: QueryTypes.UPDATE
          }
        );
      } else {
        await sequelize.query(
          `INSERT INTO contacts (name, number, email, isGroup, "companyId", business_type, needs, lead_score, createdAt, updatedAt)
           VALUES (:name, :number, :email, false, :companyId, :businessType, :needs, :leadScore, NOW(), NOW())`,
          {
            replacements: {
              name: args.name || number,
              number,
              email: args.email || "",
              companyId,
              businessType: args.businessType || null,
              needs: args.needs || null,
              leadScore: Number(args.leadScore || 0)
            },
            type: QueryTypes.INSERT
          }
        );
      }

      return res.json({ ok: true, tool, result: "contact upserted" });
    }

    if (tool === "actualizar_lead_score") {
      let contactId = Number(args.contactId || 0);
      const ticketId = Number(args.ticketId || 0);
      const inboundText = String(args.inboundText || args.text || '').trim();

      if (!contactId && ticketId) {
        const [t]: any = await sequelize.query(`SELECT "contactId" FROM tickets WHERE id = :ticketId AND "companyId" = :companyId LIMIT 1`, { replacements: { ticketId, companyId }, type: QueryTypes.SELECT });
        contactId = Number(t?.contactId || 0);
      }
      if (!contactId) return fail("contactId o ticketId requerido");

      const [existing]: any = await sequelize.query(`SELECT lead_score, "leadStatus" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`, { replacements: { contactId, companyId }, type: QueryTypes.SELECT });
      const explicitScore = Number.isFinite(Number(args.leadScore)) ? Number(args.leadScore) : null;
      const leadScore = explicitScore !== null ? Math.max(0, Math.min(100, explicitScore)) : scoreFromText(inboundText, Number(existing?.lead_score || 0));
      const leadStatus = inferLeadStatusByBotSignals({ text: inboundText, leadScore, currentStatus: String(existing?.leadStatus || "") });

      await sequelize.query(
        `UPDATE contacts SET lead_score = :leadScore, "leadStatus" = :leadStatus, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`,
        { replacements: { contactId, companyId, leadScore, leadStatus }, type: QueryTypes.UPDATE }
      );

      return res.json({ ok: true, tool, result: { contactId, leadScore, leadStatus } });
    }

    if (tool === "agregar_nota") {
      const ticketId = Number(args.ticketId || 0);
      const note = String(args.note || "").trim();
      if (!ticketId || !note) return fail("ticketId y note requeridos");

      await sequelize.query(
        `INSERT INTO ai_turns (conversation_id, role, content, model, latency_ms, tokens_in, tokens_out, created_at, updated_at)
         VALUES (NULL, 'tool', :content, 'manual-note', 0, 0, 0, NOW(), NOW())`,
        { replacements: { content: `[ticket:${ticketId}] ${note}` }, type: QueryTypes.INSERT }
      );

      return res.json({ ok: true, tool, result: "note saved" });
    }

    if (tool === "agendar_cita") {
      const contactId = Number(args.contactId || 0);
      const startsAt = String(args.startsAt || "");
      const durationMin = Number(args.durationMin || 30);
      if (!contactId || !startsAt) return fail("contactId y startsAt requeridos");

      const end = new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();

      const [appt]: any = await sequelize.query(
        `INSERT INTO appointments (company_id, contact_id, ticket_id, starts_at, ends_at, service_type, status, notes, created_at, updated_at)
         VALUES (:companyId, :contactId, :ticketId, :startsAt, :endsAt, :serviceType, 'scheduled', :notes, NOW(), NOW())
         RETURNING *`,
        {
          replacements: {
            companyId,
            contactId,
            ticketId: args.ticketId || null,
            startsAt,
            endsAt: end,
            serviceType: args.serviceType || "general",
            notes: args.notes || ""
          },
          type: QueryTypes.INSERT
        }
      );

      await sequelize.query(
        `INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
         VALUES (:appointmentId, 'create', '', :createdBy, NOW(), NOW())`,
        { replacements: { appointmentId: appt.id, createdBy: userId }, type: QueryTypes.INSERT }
      );

      return res.json({ ok: true, tool, result: appt });
    }

    if (tool === "reprogramar_cita") {
      const appointmentId = Number(args.appointmentId || 0);
      const startsAt = String(args.startsAt || "");
      const durationMin = Number(args.durationMin || 30);
      if (!appointmentId || !startsAt) return fail("appointmentId y startsAt requeridos");

      const end = new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();

      await sequelize.query(
        `UPDATE appointments SET starts_at = :startsAt, ends_at = :endsAt, status='rescheduled', updated_at = NOW()
         WHERE id = :appointmentId AND company_id = :companyId`,
        { replacements: { appointmentId, companyId, startsAt, endsAt: end }, type: QueryTypes.UPDATE }
      );

      await sequelize.query(
        `INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
         VALUES (:appointmentId, 'reschedule', :reason, :createdBy, NOW(), NOW())`,
        {
          replacements: { appointmentId, reason: String(args.reason || ""), createdBy: userId },
          type: QueryTypes.INSERT
        }
      );

      return res.json({ ok: true, tool, result: "appointment rescheduled" });
    }

    if (tool === "cancelar_cita") {
      const appointmentId = Number(args.appointmentId || 0);
      if (!appointmentId) return fail("appointmentId requerido");

      await sequelize.query(
        `UPDATE appointments SET status='cancelled', updated_at = NOW() WHERE id = :appointmentId AND company_id = :companyId`,
        { replacements: { appointmentId, companyId }, type: QueryTypes.UPDATE }
      );

      await sequelize.query(
        `INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
         VALUES (:appointmentId, 'cancel', :reason, :createdBy, NOW(), NOW())`,
        {
          replacements: { appointmentId, reason: String(args.reason || ""), createdBy: userId },
          type: QueryTypes.INSERT
        }
      );

      return res.json({ ok: true, tool, result: "appointment cancelled" });
    }

    if (tool === "consultar_conocimiento") {
      const query = String(args.query || "");
      const rows = await sequelize.query(
        `SELECT c.chunk_text, d.title, d.category,
                (CASE WHEN POSITION(LOWER(:query) IN LOWER(c.chunk_text)) > 0 THEN 0.95 ELSE 0.50 END) AS similarity
         FROM kb_chunks c
         JOIN kb_documents d ON d.id = c.document_id
         WHERE d.company_id = :companyId
           AND LOWER(c.chunk_text) LIKE LOWER(:qLike)
         ORDER BY similarity DESC
         LIMIT 5`,
        { replacements: { companyId, query, qLike: `%${query}%` }, type: QueryTypes.SELECT }
      );

      return res.json({ ok: true, tool, result: rows });
    }

    return fail(`tool no soportada: ${tool}`);
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "tool execution error" });
  }
});


aiRoutes.get("/tickets/:ticketId/decisions", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { ticketId } = req.params;
  const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 30)));

  try {
    const rows = await sequelize.query(
      `SELECT id, ticket_id, company_id, conversation_type, decision_key, reason, guardrail_action, response_preview, created_at
       FROM ai_decision_logs
       WHERE company_id = :companyId AND ticket_id = :ticketId
       ORDER BY id DESC
       LIMIT :limit`,
      { replacements: { companyId, ticketId: Number(ticketId), limit }, type: QueryTypes.SELECT }
    );
    return res.json(rows);
  } catch (e: any) {
    return res.json([]);
  }
});

let templateTablesReady = false;
const ensureTemplateTables = async () => {
  if (templateTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS message_templates (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(60) NOT NULL DEFAULT 'general',
    channel VARCHAR(30) NOT NULL DEFAULT 'whatsapp',
    content TEXT NOT NULL,
    variables_json TEXT NOT NULL DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS template_suggestions_logs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    ticket_id INTEGER,
    contact_id INTEGER,
    query_text TEXT,
    suggested_template_id INTEGER,
    suggested_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  templateTablesReady = true;
};

aiRoutes.get('/templates', isAuth, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const rows = await sequelize.query(`SELECT * FROM message_templates WHERE company_id = :companyId ORDER BY id DESC`, { replacements: { companyId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/templates', isAuth, isAdmin, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId, id: userId } = req.user;
  const { name, category = 'general', channel = 'whatsapp', content = '', variablesJson = '[]', isActive = true } = req.body || {};
  const [row]: any = await sequelize.query(`INSERT INTO message_templates (company_id, name, category, channel, content, variables_json, is_active, created_by, created_at, updated_at)
    VALUES (:companyId, :name, :category, :channel, :content, :variablesJson, :isActive, :userId, NOW(), NOW()) RETURNING *`,
    { replacements: { companyId, name, category, channel, content, variablesJson: typeof variablesJson === 'string' ? variablesJson : JSON.stringify(variablesJson || []), isActive, userId }, type: QueryTypes.INSERT });
  return res.status(201).json(row);
});

aiRoutes.put('/templates/:id', isAuth, isAdmin, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const { id } = req.params;
  const b = req.body || {};
  await sequelize.query(`UPDATE message_templates SET
      name = COALESCE(:name, name),
      category = COALESCE(:category, category),
      channel = COALESCE(:channel, channel),
      content = COALESCE(:content, content),
      variables_json = COALESCE(:variablesJson, variables_json),
      is_active = COALESCE(:isActive, is_active),
      updated_at = NOW()
    WHERE id = :id AND company_id = :companyId`, { replacements: { id: Number(id), companyId, name: b.name ?? null, category: b.category ?? null, channel: b.channel ?? null, content: b.content ?? null, variablesJson: b.variablesJson ? (typeof b.variablesJson === 'string' ? b.variablesJson : JSON.stringify(b.variablesJson)) : null, isActive: typeof b.isActive === 'boolean' ? b.isActive : null }, type: QueryTypes.UPDATE });
  const [row]: any = await sequelize.query(`SELECT * FROM message_templates WHERE id = :id AND company_id = :companyId`, { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT });
  return res.json(row || null);
});

aiRoutes.delete('/templates/:id', isAuth, isAdmin, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const { id } = req.params;
  await sequelize.query(`DELETE FROM message_templates WHERE id = :id AND company_id = :companyId`, { replacements: { id: Number(id), companyId }, type: QueryTypes.DELETE });
  return res.json({ ok: true, deletedId: Number(id) });
});

aiRoutes.post('/templates/suggest', isAuth, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const { ticketId, contactId, query = '' } = req.body || {};
  const [row]: any = await sequelize.query(`SELECT * FROM message_templates WHERE company_id = :companyId AND is_active = true ORDER BY id DESC LIMIT 1`, { replacements: { companyId }, type: QueryTypes.SELECT });
  const suggestion = row ? { templateId: row.id, content: row.content, variables: row.variables_json } : null;
  await sequelize.query(`INSERT INTO template_suggestions_logs (company_id, ticket_id, contact_id, query_text, suggested_template_id, suggested_payload_json, created_at)
    VALUES (:companyId, :ticketId, :contactId, :queryText, :templateId, :payload, NOW())`, { replacements: { companyId, ticketId: ticketId || null, contactId: contactId || null, queryText: String(query || ''), templateId: suggestion?.templateId || null, payload: JSON.stringify(suggestion || {}) }, type: QueryTypes.INSERT });
  return res.json({ suggestion });
});

aiRoutes.post('/templates/send', isAuth, async (req: any, res) => {
  const { templateId, ticketId, contactId, payload = {} } = req.body || {};
  return res.json({ ok: true, queued: true, templateId: Number(templateId || 0), ticketId: Number(ticketId || 0), contactId: Number(contactId || 0), payload, note: 'Scaffold: conectar envÃ­o real con canal WhatsApp/Cloud' });
});

aiRoutes.get('/meta/oauth/start', isAuth, async (req: any, res) => {
  await ensureMetaOauthTables();
  const oauth = getMetaOauthConfig(req);
  if (!oauth.clientId || !oauth.redirectUri) {
    return res.status(400).json({ ok: false, error: 'missing_meta_oauth_config', required: ['META_APP_ID|runtime.metaLeadAdsAppId', 'META_OAUTH_REDIRECT_URI'] });
  }

  const companyId = Number(req.user?.companyId || 0);
  const userId = Number(req.user?.id || 0) || null;
  const redirectAfter = String(req.query.redirectAfter || req.body?.redirectAfter || '/settings').slice(0, 650);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({ companyId, userId, nonce, ts: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = signMetaState(payloadB64);
  const state = `${payloadB64}.${sig}`;

  await sequelize.query(
    `INSERT INTO meta_oauth_states (company_id, user_id, nonce, state_hash, redirect_after, status, expires_at)
     VALUES (:companyId, :userId, :nonce, :stateHash, :redirectAfter, 'pending', NOW() + INTERVAL '10 minutes')`,
    {
      replacements: {
        companyId,
        userId,
        nonce,
        stateHash: crypto.createHash('sha256').update(state).digest('hex'),
        redirectAfter
      },
      type: QueryTypes.INSERT
    }
  );

  const scope = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
    'business_management'
  ].join(',');

  const oauthUrl = `https://www.facebook.com/${graphApiVersion}/dialog/oauth?` + new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    state,
    response_type: 'code',
    scope
  }).toString();

  return res.json({ ok: true, oauthUrl, statePreview: `${state.slice(0, 10)}...` });
});

aiRoutes.get('/meta/oauth/callback', async (req: any, res) => {
  await ensureMetaOauthTables();

  if (String(req.query.error || '')) {
    return res.status(400).send(`Meta OAuth error: ${String(req.query.error_description || req.query.error || 'unknown')}`);
  }

  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (!code || !state || !state.includes('.')) return res.status(400).send('Missing code/state');

  const [payloadB64, sig] = state.split('.', 2);
  if (signMetaState(payloadB64) !== sig) return res.status(400).send('Invalid state signature');

  const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const companyId = Number(decoded?.companyId || 0);
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');

  const [stateRow]: any = await sequelize.query(
    `SELECT * FROM meta_oauth_states
     WHERE state_hash = :stateHash AND company_id = :companyId AND status = 'pending' AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    { replacements: { stateHash, companyId }, type: QueryTypes.SELECT }
  );
  if (!stateRow) return res.status(400).send('State expired/used');

  const oauth = getMetaOauthConfig(req);
  if (!oauth.clientId || !oauth.clientSecret || !oauth.redirectUri) {
    return res.status(400).send('Missing OAuth config on server (env/runtime)');
  }

  const tokenUrl = `https://graph.facebook.com/${graphApiVersion}/oauth/access_token?` + new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: oauth.redirectUri,
    code
  }).toString();

  const tokenResp = await fetch(tokenUrl);
  const tokenData: any = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenData?.access_token) {
    return res.status(400).send(`Token exchange failed: ${tokenData?.error?.message || tokenResp.status}`);
  }

  const accessToken = String(tokenData.access_token);
  const meBusinessesResp = await fetch(`https://graph.facebook.com/${graphApiVersion}/me/businesses?fields=id,name&access_token=${encodeURIComponent(accessToken)}`);
  const meBusinesses: any = await meBusinessesResp.json().catch(() => ({}));
  const businessId = String(meBusinesses?.data?.[0]?.id || '');

  let wabaId = '';
  let phoneNumberId = '';
  let phoneDisplay = '';
  if (businessId) {
    const wabaResp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${businessId}/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number}&access_token=${encodeURIComponent(accessToken)}`);
    const wabaData: any = await wabaResp.json().catch(() => ({}));
    wabaId = String(wabaData?.data?.[0]?.id || '');
    phoneNumberId = String(wabaData?.data?.[0]?.phone_numbers?.data?.[0]?.id || '');
    phoneDisplay = String(wabaData?.data?.[0]?.phone_numbers?.data?.[0]?.display_phone_number || '');
  }

  await sequelize.query(
    `INSERT INTO meta_connections (company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, access_token, token_type, token_expires_at, scopes_json, status, created_at, updated_at)
     VALUES (:companyId, :businessId, :wabaId, :phoneNumberId, :phoneDisplay, :accessToken, :tokenType, :expiresAt, :scopesJson, 'connected', NOW(), NOW())`,
    {
      replacements: {
        companyId,
        businessId: businessId || null,
        wabaId: wabaId || null,
        phoneNumberId: phoneNumberId || null,
        phoneDisplay: phoneDisplay || null,
        accessToken,
        tokenType: String(tokenData.token_type || 'bearer'),
        expiresAt: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000) : null,
        scopesJson: JSON.stringify(tokenData.scope || [])
      },
      type: QueryTypes.INSERT
    }
  );

  await sequelize.query(
    `UPDATE meta_oauth_states SET status = 'used', used_at = NOW() WHERE id = :id`,
    { replacements: { id: Number(stateRow.id) }, type: QueryTypes.UPDATE }
  );

  const redirectAfter = String(stateRow.redirect_after || '/settings');
  return res.redirect(`${redirectAfter}${redirectAfter.includes('?') ? '&' : '?'}meta_oauth=ok`);
});

aiRoutes.get('/meta/oauth/status', isAuth, async (req: any, res) => {
  await ensureMetaOauthTables();
  const { companyId } = req.user;
  const [row]: any = await sequelize.query(
    `SELECT id, company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, token_expires_at, status, updated_at
     FROM meta_connections
     WHERE company_id = :companyId
     ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return res.json(row || { connected: false });
});

aiRoutes.post('/meta/oauth/test-send', isAuth, async (req: any, res) => {
  await ensureMetaOauthTables();
  const { companyId } = req.user;
  const to = String(req.body?.to || '').replace(/\D/g, '');
  const text = String(req.body?.text || 'Test exitoso desde Charlott OAuth + WhatsApp Cloud API');
  const templateName = String(req.body?.templateName || '').trim();
  const languageCode = String(req.body?.languageCode || 'en').trim();
  const templateVariables = Array.isArray(req.body?.templateVariables)
    ? req.body.templateVariables.map((v: any) => String(v ?? '')).filter((v: string) => v.length > 0).slice(0, 8)
    : undefined;
  const idempotencyHeaderXRaw = String(req.headers?.["x-idempotency-key"] || "").trim();
  const idempotencyHeaderStdRaw = String(req.headers?.["idempotency-key"] || "").trim();
  const idempotencyBodyRaw = String(req.body?.idempotencyKey || "").trim();
  const idempotencyHeaderX = normalizeIdempotencyKey(idempotencyHeaderXRaw);
  const idempotencyHeaderStd = normalizeIdempotencyKey(idempotencyHeaderStdRaw);
  const idempotencyBody = normalizeIdempotencyKey(idempotencyBodyRaw);

  if (!to) return res.status(400).json({ ok: false, error: 'missing_to' });

  if (idempotencyHeaderXRaw && idempotencyHeaderXRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ ok: false, error: `x-idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderStdRaw && idempotencyHeaderStdRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ ok: false, error: `idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyBodyRaw && idempotencyBodyRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ ok: false, error: `body.idempotencyKey too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderXRaw && hasInvalidIdempotencyChars(idempotencyHeaderXRaw)) {
    return res.status(400).json({ ok: false, error: "x-idempotency-key contains invalid characters" });
  }

  if (idempotencyHeaderStdRaw && hasInvalidIdempotencyChars(idempotencyHeaderStdRaw)) {
    return res.status(400).json({ ok: false, error: "idempotency-key contains invalid characters" });
  }

  if (idempotencyBodyRaw && hasInvalidIdempotencyChars(idempotencyBodyRaw)) {
    return res.status(400).json({ ok: false, error: "body.idempotencyKey contains invalid characters" });
  }

  if (idempotencyHeaderX && idempotencyHeaderStd && idempotencyHeaderX !== idempotencyHeaderStd) {
    return res.status(400).json({ ok: false, error: "idempotency key mismatch between x-idempotency-key and idempotency-key headers" });
  }

  const idempotencyHeader = idempotencyHeaderX || idempotencyHeaderStd;

  if (idempotencyHeader && idempotencyBody && idempotencyHeader !== idempotencyBody) {
    return res.status(400).json({ ok: false, error: "idempotency key mismatch between header and body" });
  }

  const effectiveIdempotencyKey = idempotencyHeader || idempotencyBody;
  const retryAttemptResolution = resolveRetryAttempt(req);
  const retryAttempt = retryAttemptResolution.retryAttempt;
  const isExplicitRetry = retryAttempt !== null && retryAttempt > 1;

  if (retryAttemptResolution.invalidRaw) {
    return res.status(400).json({
      ok: false,
      error: "retryAttempt invalid (allowed integer range: 1..1000)",
      retryAttempt: retryAttemptResolution.invalidRaw
    });
  }

  if (resolveOutboundRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    return res.status(400).json({ ok: false, error: "x-idempotency-key (or body.idempotencyKey) is required by hardening" });
  }

  if (isExplicitRetry && resolveOutboundRetryRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    return res.status(400).json({ ok: false, error: "x-idempotency-key (or body.idempotencyKey) is required for safe retries (retryAttempt > 1)" });
  }

  if (effectiveIdempotencyKey && effectiveIdempotencyKey.length < resolveOutboundIdempotencyKeyMinLength()) {
    return res.status(400).json({
      ok: false,
      error: `x-idempotency-key too short (min ${resolveOutboundIdempotencyKeyMinLength()})`
    });
  }

  if (effectiveIdempotencyKey && isTimestampOnlyIdempotencyKey(effectiveIdempotencyKey)) {
    return res.status(400).json({
      ok: false,
      error: "x-idempotency-key timestamp-only not allowed (use UUID/ULID or high-entropy key)"
    });
  }

  if (effectiveIdempotencyKey && isWeakIdempotencyKey(effectiveIdempotencyKey)) {
    return res.status(400).json({
      ok: false,
      error: "x-idempotency-key too weak (use at least 2 distinct, non-sequential characters)"
    });
  }

  const [conn]: any = await sequelize.query(
    `SELECT * FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  if (!conn?.access_token || !conn?.phone_number_id) {
    return res.status(400).json({ ok: false, error: 'missing_connection_or_phone', hint: 'Complete OAuth y selecciona WABA/numero valido' });
  }

  let messageId = '';
  if (templateName) {
    messageId = await sendCloudTemplateWithCredentials(
      String(conn.phone_number_id),
      String(conn.access_token),
      to,
      templateName,
      languageCode || 'en',
      effectiveIdempotencyKey || undefined,
      templateVariables
    );
    return res.json({ ok: true, mode: 'template', messageId, to, phoneNumberId: conn.phone_number_id, templateName, languageCode, idempotencyKeyUsed: Boolean(effectiveIdempotencyKey) });
  }

  messageId = await sendCloudTextWithCredentials(
    String(conn.phone_number_id),
    String(conn.access_token),
    to,
    text,
    effectiveIdempotencyKey || undefined
  );
  return res.json({ ok: true, mode: 'text', messageId, to, phoneNumberId: conn.phone_number_id, text, idempotencyKeyUsed: Boolean(effectiveIdempotencyKey) });
});

let metaLeadTablesReady = false;
const META_LEAD_REPLAY_TTL_SECONDS = 60 * 60 * 48;
const buildMetaLeadReplayKey = (companyId: number, body: any) => {
  const eventId = String(body?.event_id || body?.id || '').trim();
  const leadgenId = String(body?.leadgen_id || body?.lead?.id || '').trim();
  const pageId = String(body?.page_id || body?.page?.id || '').trim();
  const fallback = JSON.stringify(body || {}).slice(0, 1800);
  const base = [companyId, eventId || '-', leadgenId || '-', pageId || '-', fallback].join(':');
  return `meta-lead:${crypto.createHash('sha1').update(base).digest('hex')}`;
};

const reserveMetaLeadReplayKey = async (replayKey: string, ttlSeconds = META_LEAD_REPLAY_TTL_SECONDS): Promise<boolean> => {
  await sequelize.query(`DELETE FROM meta_lead_replay_guard WHERE created_at < NOW() - (:ttlSeconds::text || ' seconds')::interval`, {
    replacements: { ttlSeconds },
    type: QueryTypes.DELETE
  });

  const rows: any[] = await sequelize.query(
    `INSERT INTO meta_lead_replay_guard (replay_key, created_at)
     VALUES (:replayKey, NOW())
     ON CONFLICT (replay_key) DO NOTHING
     RETURNING replay_key`,
    { replacements: { replayKey }, type: QueryTypes.SELECT }
  );

  return Boolean(rows[0]?.replay_key);
};

const ensureMetaLeadTables = async () => {
  if (metaLeadTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_lead_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    event_id VARCHAR(120),
    page_id VARCHAR(120),
    form_id VARCHAR(120),
    form_name VARCHAR(255),
    leadgen_id VARCHAR(120),
    ad_id VARCHAR(120),
    campaign_id VARCHAR(120),
    adset_id VARCHAR(120),
    source VARCHAR(60) DEFAULT 'meta_lead_ads',
    form_fields_json TEXT NOT NULL DEFAULT '{}',
    payload_json TEXT NOT NULL DEFAULT '{}',
    contact_phone VARCHAR(60),
    contact_email VARCHAR(160),
    contact_name VARCHAR(180),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`ALTER TABLE meta_lead_events ADD COLUMN IF NOT EXISTS form_name VARCHAR(255)`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_lead_replay_guard (
    id SERIAL PRIMARY KEY,
    replay_key VARCHAR(220) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_lead_replay_guard_key ON meta_lead_replay_guard(replay_key)`);
  metaLeadTablesReady = true;
};

const ensureMetaFormsTag = async (contactId: number) => {
  const [tag]: any = await sequelize.query(
    `INSERT INTO tags (name, color, "createdAt", "updatedAt")
     VALUES ('Formularios meta', '#2563EB', NOW(), NOW())
     ON CONFLICT (name)
     DO UPDATE SET "updatedAt" = NOW()
     RETURNING id`,
    { type: QueryTypes.SELECT }
  );

  if (!tag?.id) return;

  await sequelize.query(
    `INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
     VALUES (:contactId, :tagId, NOW(), NOW())
     ON CONFLICT ("contactId", "tagId") DO NOTHING`,
    { replacements: { contactId, tagId: Number(tag.id) }, type: QueryTypes.INSERT }
  );
};

const ensureContactTag = async (contactId: number, tagName: string, color = '#64748B') => {
  const [tag]: any = await sequelize.query(
    `INSERT INTO tags (name, color, "createdAt", "updatedAt")
     VALUES (:tagName, :color, NOW(), NOW())
     ON CONFLICT (name)
     DO UPDATE SET "updatedAt" = NOW()
     RETURNING id`,
    { replacements: { tagName, color }, type: QueryTypes.SELECT }
  );

  if (!tag?.id) return;

  await sequelize.query(
    `INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
     VALUES (:contactId, :tagId, NOW(), NOW())
     ON CONFLICT ("contactId", "tagId") DO NOTHING`,
    { replacements: { contactId, tagId: Number(tag.id) }, type: QueryTypes.INSERT }
  );
};

const resolveMetaWebhookSignatureSecret = (): string => {
  const runtime = getRuntimeSettings() as any;
  const runtimeSecret = String(runtime?.metaLeadAdsAppSecret || "").trim();
  if (runtimeSecret) return runtimeSecret;

  // Check the same env vars that metaWebhookRoutes uses for signature
  // verification to ensure both handlers agree on the secret.
  return String(process.env.META_LEAD_ADS_APP_SECRET || process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET || "").trim();
};

const resolveMetaWebhookSignatureRequired = (): boolean => {
  const runtime = getRuntimeSettings() as any;
  const raw = runtime?.metaLeadAdsWebhookRequireSignature;

  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const verifyMetaWebhookSignature = (req: any, body: any): { ok: boolean; reason?: string } => {
  const signatureHeader = String(req.headers?.["x-hub-signature-256"] || "").trim();
  const signatureSecret = resolveMetaWebhookSignatureSecret();

  if (!signatureHeader) return { ok: false, reason: "missing_signature_header" };
  if (!signatureSecret) return { ok: false, reason: "missing_signature_secret" };
  if (!signatureHeader.startsWith("sha256=")) return { ok: false, reason: "invalid_signature_format" };

  const provided = signatureHeader.slice("sha256=".length).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) return { ok: false, reason: "invalid_signature_hex" };

  const rawPayload = typeof req?.rawBody === "string" && req.rawBody.length > 0
    ? req.rawBody
    : JSON.stringify(body || {});
  const expected = crypto.createHmac("sha256", signatureSecret).update(rawPayload, "utf8").digest("hex");

  try {
    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (providedBuf.length !== expectedBuf.length) return { ok: false, reason: "signature_length_mismatch" };
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return { ok: false, reason: "signature_mismatch" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "signature_compare_failed" };
  }
};

aiRoutes.get('/meta-leads/webhook', async (req: any, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const s = getRuntimeSettings();
  if (mode === 'subscribe' && token && token === String(s.metaLeadAdsWebhookVerifyToken || '')) return res.status(200).send(challenge || 'ok');
  return res.status(403).json({ ok: false, error: 'verification_failed' });
});

const fetchLeadgenDetails = async (companyId: number, leadgenId: string): Promise<any | null> => {
  if (!leadgenId) return null;
  const { clientId, clientSecret } = getMetaOauthConfig();
  const tokens: string[] = [];
  if (clientId && clientSecret) tokens.push(`${clientId}|${clientSecret}`);

  const [conn]: any = await sequelize.query(
    `SELECT access_token FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  if (conn?.access_token) tokens.push(String(conn.access_token));

  for (const accessToken of tokens) {
    try {
      const url = new URL(`https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(leadgenId)}`);
      url.searchParams.set('fields', 'id,created_time,field_data,form_id,ad_id,campaign_id,adgroup_id');
      url.searchParams.set('access_token', accessToken);
      const resp = await fetch(url.toString());
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.id) return data;
    } catch {
      // try next token
    }
  }
  return null;
};

const extractMetaLeadEvents = async (body: any, companyId: number): Promise<any[]> => {
  if (body?.object === 'page' && Array.isArray(body?.entry)) {
    const events: any[] = [];
    for (const entry of body.entry) {
      const pageId = String(entry?.id || '').trim();
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const ch of changes) {
        const field = String(ch?.field || '').toLowerCase();
        const value = ch?.value || {};
        const leadgenId = String(value?.leadgen_id || value?.lead?.id || '').trim();
        if (field !== 'leadgen' && !leadgenId) continue;
        const leadDetails = await fetchLeadgenDetails(companyId, leadgenId);
        events.push({
          companyId,
          event_id: String(value?.event_id || `${pageId}:${leadgenId}:${String(value?.created_time || '')}`),
          page_id: String(value?.page_id || pageId),
          form_id: String(value?.form_id || leadDetails?.form_id || ''),
          leadgen_id: leadgenId,
          ad_id: String(value?.ad_id || leadDetails?.ad_id || ''),
          campaign_id: String(value?.campaign_id || leadDetails?.campaign_id || ''),
          adset_id: String(value?.adset_id || value?.adgroup_id || leadDetails?.adgroup_id || ''),
          field_data: leadDetails?.field_data || [],
          _rawPayload: body
        });
      }
    }
    return events;
  }
  return [body || {}];
};

const processMetaLeadEvent = async (body: any) => {
  const incomingLeadgenId = String(body?.leadgen_id || body?.lead?.id || '').trim();
  let fieldData: any = body?.form_fields || body?.field_data || body?.lead?.field_data || {};
  let hasAnyFieldData = Array.isArray(fieldData)
    ? fieldData.length > 0
    : (fieldData && typeof fieldData === 'object' ? Object.keys(fieldData).length > 0 : Boolean(fieldData));

  // If payload comes flattened (e.g. via relay/n8n) with leadgen_id but without field_data,
  // backfill lead details from Graph before extracting contact fields.
  if (!hasAnyFieldData && incomingLeadgenId) {
    try {
      const details = await fetchLeadgenDetails(Number(body.companyId || 1), incomingLeadgenId);
      if (details?.id) {
        fieldData = Array.isArray(details.field_data) ? details.field_data : fieldData;
        hasAnyFieldData = Array.isArray(fieldData)
          ? fieldData.length > 0
          : (fieldData && typeof fieldData === 'object' ? Object.keys(fieldData).length > 0 : Boolean(fieldData));
        body.form_id = String(body.form_id || details.form_id || '').trim();
        body.ad_id = String(body.ad_id || details.ad_id || '').trim();
        body.campaign_id = String(body.campaign_id || details.campaign_id || '').trim();
        body.adset_id = String(body.adset_id || details.adgroup_id || '').trim();
      }
    } catch {
      // keep original payload; downstream guard handles no-op events
    }
  }

  // Ignore malformed/no-op payloads to avoid polluting reports with empty lead rows.
  if (!incomingLeadgenId && !hasAnyFieldData) {
    return { ok: true, ingested: false, outreach: false, reason: 'missing_lead_payload' };
  }

  const getField = (k: string) => {
    if (!fieldData) return '';
    if (Array.isArray(fieldData)) {
      const found = fieldData.find((x: any) => String(x?.name || '').toLowerCase() === k.toLowerCase());
      return found?.values?.[0] || '';
    }
    return fieldData[k] || '';
  };

  const companyId = Number(body.companyId || 1);
  const replayKey = buildMetaLeadReplayKey(companyId, body);
  const accepted = await reserveMetaLeadReplayKey(replayKey, META_LEAD_REPLAY_TTL_SECONDS);
  if (!accepted) return { ok: true, ingested: false, outreach: false, reason: 'replay_blocked' };

  const phoneRaw = String(getField('phone_number') || getField('telefono') || body.phone || '').trim();
  const phone = phoneRaw.replace(/\D/g, '');
  const email = String(getField('email') || body.email || '').trim();
  const name = String(getField('full_name') || getField('nombre') || body.name || '').trim();
  const formId = String(body.form_id || body?.form?.id || '').trim();
  const formNameFromPayload = String(body.form_name || body?.form?.name || body?.lead?.form_name || '').trim();
  const formName = formNameFromPayload || await resolveMetaFormName(companyId, formId);
  const sourceLabel = String(formName || (formId ? `Formulario ${formId}` : 'Meta Lead Ads')).trim();

  await sequelize.query(`INSERT INTO meta_lead_events (company_id, event_id, page_id, form_id, form_name, leadgen_id, ad_id, campaign_id, adset_id, form_fields_json, payload_json, contact_phone, contact_email, contact_name, created_at, updated_at)
    VALUES (:companyId, :eventId, :pageId, :formId, :formName, :leadgenId, :adId, :campaignId, :adsetId, :formFieldsJson, :payloadJson, :phone, :email, :name, NOW(), NOW())`, {
    replacements: {
      companyId,
      eventId: String(body.event_id || body.id || ''),
      pageId: String(body.page_id || ''),
      formId,
      formName,
      leadgenId: incomingLeadgenId,
      adId: String(body.ad_id || ''),
      campaignId: String(body.campaign_id || ''),
      adsetId: String(body.adset_id || ''),
      formFieldsJson: JSON.stringify(fieldData || {}),
      payloadJson: JSON.stringify(body._rawPayload || body || {}),
      phone: phoneRaw,
      email,
      name
    },
    type: QueryTypes.INSERT
  });

  const normalizedPhone = normalizeWaPhone(phone);
  if (!normalizedPhone) return { ok: true, ingested: true, outreach: false, reason: 'no_phone' };

  let contact: any = await Contact.findOne({ where: { number: normalizedPhone, companyId } } as any);
  if (!contact) {
    const [fallbackBySuffix]: any = await sequelize.query(
      `SELECT id FROM contacts WHERE "companyId" = :companyId AND RIGHT(REGEXP_REPLACE(COALESCE(number,''), '\\D', '', 'g'), 10) = :last10 ORDER BY id DESC LIMIT 1`,
      { replacements: { companyId, last10: normalizedPhone.slice(-10) }, type: QueryTypes.SELECT }
    );
    if (fallbackBySuffix?.id) {
      contact = await Contact.findByPk(Number(fallbackBySuffix.id));
    }
  }

  if (!contact) contact = await Contact.create({ name: name || normalizedPhone, number: normalizedPhone, email, source: sourceLabel, companyId, isGroup: false, lead_score: scoreFromText(JSON.stringify(fieldData || {}), 0), leadStatus: 'nuevo_ingreso', needs: JSON.stringify(fieldData || {}).slice(0, 900) } as any);
  else await contact.update({ name: name || contact.name, number: normalizeWaPhone(String(contact.number || normalizedPhone)), email: email || contact.email, source: (!String(contact.source || '').trim() || /^meta_form_/i.test(String(contact.source || '').trim())) ? sourceLabel : contact.source, lead_score: scoreFromText(JSON.stringify(fieldData || {}), Number(contact.lead_score || 0)), leadStatus: String(contact.leadStatus || '').trim() || 'nuevo_ingreso', needs: JSON.stringify(fieldData || {}).slice(0, 900), updatedAt: new Date() } as any);


  await ensureMetaFormsTag(Number(contact.id));

  const tokkoLeadSync: any = await syncLeadToTokko({
    name: String(name || contact?.name || '').trim(),
    phone,
    email,
    message: `Lead Meta Ads ${String(formName || '').trim() ? `(form ${String(formName).trim()})` : (String(formId || '').trim() ? `(form ${String(formId).trim()})` : '')}`,
    source: 'meta-lead-webhook'
  });
  if (tokkoLeadSync?.ok) {
    await ensureContactTag(Number(contact.id), 'enviado_tokko', '#0EA5E9');
  }

  const whatsapp: any = await resolveWhatsapp(companyId);
  let ticket: any = await Ticket.findOne({ where: { contactId: contact.id, whatsappId: whatsapp.id }, order: [['updatedAt', 'DESC']] } as any);
  if (ticket && !['open', 'pending'].includes(String(ticket.status || ''))) ticket = null;
  const createdNewTicket = !ticket;
  if (!ticket) ticket = await Ticket.create({ contactId: contact.id, whatsappId: whatsapp.id, companyId, status: 'pending', unreadMessages: 0, lastMessage: 'Nuevo lead Meta Ads' } as any);

  let helloTemplateSent = false;
  let helloTemplateError: string | null = null;

  if (createdNewTicket && normalizedPhone) {
    const runtime = getRuntimeSettings() as any;
    const helloTemplateName = String(runtime.waFirstContactHolaTemplateName || process.env.WA_FIRST_CONTACT_HOLA_TEMPLATE_NAME || 'hola').trim();
    const helloTemplateLang = String(runtime.waFirstContactHolaTemplateLang || process.env.WA_FIRST_CONTACT_HOLA_TEMPLATE_LANG || 'es_AR').trim();

    try {
      const [conn]: any = await sequelize.query(
        `SELECT * FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1`,
        { replacements: { companyId }, type: QueryTypes.SELECT }
      );

      if (conn?.access_token && conn?.phone_number_id && helloTemplateName) {
        const firstName = String(name || contact?.name || '').trim().split(/\s+/)[0] || 'Hola';
        const helloMessageId = await sendCloudTemplateWithCredentials(
          String(conn.phone_number_id),
          String(conn.access_token),
          normalizedPhone,
          helloTemplateName,
          helloTemplateLang,
          `meta-hola:${companyId}:${incomingLeadgenId || ticket.id}`,
          [firstName]
        );

        helloTemplateSent = true;
        const helloPreview = buildHolaTemplatePreview(firstName);

        await ticket.update({
          status: 'open',
          lastMessage: helloPreview,
          updatedAt: new Date()
        } as any);

        await Message.create({
          id: String(helloMessageId || `meta-hola-${ticket.id}-${Date.now()}`),
          body: helloPreview,
          fromMe: true,
          ack: 1,
          read: true,
          mediaType: 'chat',
          ticketId: Number(ticket.id),
          contactId: Number(contact.id),
          providerMessageId: String(helloMessageId || '')
        } as any);
      } else {
        helloTemplateError = 'missing_meta_connection_or_phone';
      }
    } catch (e: any) {
      helloTemplateError = String(e?.message || e || 'hello_template_failed');
      try {
        await ticket.update({
          status: 'pending',
          lastMessage: 'Lead creado (falló template Hola inicial)',
          updatedAt: new Date()
        } as any);
      } catch {
        // no-op
      }
    }
  }

  return {
    ok: true,
    ingested: true,
    outreach: true,
    contactId: contact.id,
    ticketId: ticket.id,
    helloTemplate: {
      sent: helloTemplateSent,
      error: helloTemplateError
    },
    tokko: {
      synced: Boolean(tokkoLeadSync?.ok),
      skipped: Boolean(tokkoLeadSync?.skipped),
      statusCode: tokkoLeadSync?.status || null
    }
  };
};

aiRoutes.post('/meta-leads/webhook', async (req: any, res) => {
  await ensureMetaLeadTables();
  const rootBody = req.body || {};

  const signatureCheck = verifyMetaWebhookSignature(req, rootBody);
  const signatureRequired = resolveMetaWebhookSignatureRequired();
  if (!signatureCheck.ok) {
    if (signatureRequired) {
      console.warn('[meta-leads][hardening] blocked webhook due to invalid signature', {
        reason: signatureCheck.reason
      });
      return res.status(401).json({ ok: false, error: 'invalid_signature', reason: signatureCheck.reason });
    }

    console.warn('[meta-leads][hardening] signature validation failed but accepted due to fail-open setting', {
      reason: signatureCheck.reason
    });
  }

  const companyId = Number(rootBody.companyId || 1);
  const events = await extractMetaLeadEvents(rootBody, companyId);
  const results = [] as any[];
  for (const ev of events) {
    try {
      results.push(await processMetaLeadEvent(ev));
    } catch (e: any) {
      results.push({ ok: false, error: String(e?.message || e || 'event_failed') });
    }
  }
  return res.json({ ok: true, ingested: results.some((r) => r?.ingested), events: results.length, results });
});

aiRoutes.get('/meta-leads/context/:phone', isAuth, async (req: any, res) => {
  await ensureMetaLeadTables();
  const { companyId } = req.user;
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  const [row]: any = await sequelize.query(`SELECT id, form_id, form_name, campaign_id, ad_id, contact_name, contact_email, form_fields_json, created_at
    FROM meta_lead_events
    WHERE company_id = :companyId AND REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g') = :phone
    ORDER BY id DESC LIMIT 1`, { replacements: { companyId, phone }, type: QueryTypes.SELECT });
  return res.json(row || null);
});

let crmFeatureTablesReady = false;
const ensureCrmFeatureTables = async () => {
  if (crmFeatureTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS internal_notes (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    mentions_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS integration_errors (
    id SERIAL PRIMARY KEY,
    company_id INTEGER,
    source VARCHAR(30) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    error_code VARCHAR(120),
    message TEXT NOT NULL,
    suggestion TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS followup_sequences (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    ticket_id INTEGER,
    contact_id INTEGER,
    day_offset INTEGER NOT NULL,
    template_text TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    executed_at TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(180),
    sequence_group VARCHAR(180),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(180)`);
  await sequelize.query(`ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS sequence_group VARCHAR(180)`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_company_idempotency ON followup_sequences(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

  await sequelize.query(`CREATE TABLE IF NOT EXISTS lead_score_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    previous_score INTEGER,
    new_score INTEGER NOT NULL,
    previous_status VARCHAR(30),
    new_status VARCHAR(30),
    reason VARCHAR(120) NOT NULL DEFAULT 'manual',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_lead_score_events_company_contact ON lead_score_events(company_id, contact_id, id DESC)`);
  crmFeatureTablesReady = true;
};

const parseMentions = (text: string) => Array.from(new Set((String(text || '').match(/@([a-zA-Z0-9_.-]{2,40})/g) || []).map((m) => m.slice(1).toLowerCase())));
const renderTemplate = (template: string, vars: Record<string, any>) => String(template || '').replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_m, key) => String(vars?.[key] ?? ''));

const scoreLead = ({ source = '', interactions = 0, inactiveDays = 0, tags = [] }: { source?: string; interactions?: number; inactiveDays?: number; tags?: string[] }) => {
  let score = 20;
  if (/meta|ads|referido|organic/i.test(String(source))) score += 20;
  score += Math.min(30, Math.max(0, Number(interactions || 0)) * 3);
  score -= Math.min(30, Math.max(0, Number(inactiveDays || 0)) * 2);
  if ((tags || []).some((t) => /vip|hot|inversor|urgente/i.test(String(t)))) score += 20;
  if ((tags || []).some((t) => /spam|baja|no_interesado/i.test(String(t)))) score -= 25;
  return Math.max(0, Math.min(100, Math.round(score)));
};

const normalizePhone = (value: any) => String(value || '').replace(/\D/g, '');
const normalizeEmail = (value: any) => String(value || '').trim().toLowerCase();
const parseTags = (value: any): string[] => {
  if (Array.isArray(value)) return value.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
    } catch {}
    return value.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
};

const logIntegrationError = async (args: { companyId?: number; source: 'whatsapp' | 'meta' | 'tokko'; severity?: 'low' | 'medium' | 'high'; errorCode?: string; message: string; suggestion?: string; payload?: any }) => {
  await ensureCrmFeatureTables();
  await sequelize.query(`INSERT INTO integration_errors (company_id, source, severity, error_code, message, suggestion, payload_json, created_at)
    VALUES (:companyId, :source, :severity, :errorCode, :message, :suggestion, :payloadJson, NOW())`, {
    replacements: {
      companyId: args.companyId || null,
      source: args.source,
      severity: args.severity || 'medium',
      errorCode: args.errorCode || null,
      message: args.message,
      suggestion: args.suggestion || null,
      payloadJson: JSON.stringify(args.payload || {})
    },
    type: QueryTypes.INSERT
  });
};

aiRoutes.get('/sla/overdue', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const runtime = getRuntimeSettings();
  const slaMinutes = Math.max(1, Number(req.query.slaMinutes || runtime.slaMinutes || 60));
  const shouldAutoAssign = String(req.query.autoAssign || '') === '1' || runtime.slaAutoReassign;

  const overdue: any[] = await sequelize.query(`
    SELECT t.id, t.status, t."userId", t."contactId", t."updatedAt", t."createdAt",
           EXTRACT(EPOCH FROM (NOW() - COALESCE(t."updatedAt", t."createdAt")))/60 AS elapsed_minutes
    FROM tickets t
    WHERE t."companyId" = :companyId
      AND t.status IN ('open','pending')
      AND EXTRACT(EPOCH FROM (NOW() - COALESCE(t."updatedAt", t."createdAt")))/60 > :slaMinutes
    ORDER BY elapsed_minutes DESC
    LIMIT 500`, { replacements: { companyId, slaMinutes }, type: QueryTypes.SELECT });

  let reassigned = 0;
  let suggestions = 0;
  const usersLoad: any[] = await sequelize.query(`
    SELECT t."userId" AS user_id, COUNT(*)::int AS open_count
    FROM tickets t
    WHERE t."companyId" = :companyId AND t.status IN ('open','pending') AND t."userId" IS NOT NULL
    GROUP BY t."userId"
    ORDER BY open_count ASC`, { replacements: { companyId }, type: QueryTypes.SELECT });
  const bestUserId = Number(usersLoad?.[0]?.user_id || 0) || null;

  for (const t of overdue) {
    (t as any).suggestedUserId = bestUserId;
    if (!bestUserId || Number(t.userId || 0) === bestUserId) continue;
    if (runtime.slaSuggestOnly && !shouldAutoAssign) { suggestions += 1; continue; }
    if (shouldAutoAssign) {
      await sequelize.query(`UPDATE tickets SET "userId" = :userId, "updatedAt" = NOW() WHERE id = :ticketId AND "companyId" = :companyId`, { replacements: { userId: bestUserId, ticketId: Number(t.id), companyId }, type: QueryTypes.UPDATE });
      reassigned += 1;
    }
  }

  return res.json({ slaMinutes, totalOverdue: overdue.length, reassigned, suggestions, tickets: overdue });
});

aiRoutes.get('/notes', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const entityType = String(req.query.entityType || 'ticket');
  const entityId = Number(req.query.entityId || 0);
  if (!entityId) return res.status(400).json({ error: 'entityId requerido' });
  const rows = await sequelize.query(`SELECT * FROM internal_notes WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId ORDER BY id DESC`, { replacements: { companyId, entityType, entityId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/notes', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId, id: userId } = req.user;
  const entityType = String(req.body?.entityType || 'ticket');
  const entityId = Number(req.body?.entityId || 0);
  const content = String(req.body?.content || '').trim();
  if (!entityId || !content) return res.status(400).json({ error: 'entityId y content requeridos' });
  const mentions = parseMentions(content);
  const [row]: any = await sequelize.query(`INSERT INTO internal_notes (company_id, entity_type, entity_id, content, mentions_json, created_by, created_at, updated_at)
    VALUES (:companyId, :entityType, :entityId, :content, :mentionsJson, :createdBy, NOW(), NOW()) RETURNING *`, { replacements: { companyId, entityType, entityId, content, mentionsJson: JSON.stringify(mentions), createdBy: userId }, type: QueryTypes.INSERT });
  return res.status(201).json(row);
});

aiRoutes.put('/notes/:id', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const id = Number(req.params.id || 0);
  const content = String(req.body?.content || '').trim();
  if (!id || !content) return res.status(400).json({ error: 'id y content requeridos' });
  const mentions = parseMentions(content);
  await sequelize.query(`UPDATE internal_notes SET content = :content, mentions_json = :mentionsJson, updated_at = NOW() WHERE id = :id AND company_id = :companyId`, { replacements: { id, companyId, content, mentionsJson: JSON.stringify(mentions) }, type: QueryTypes.UPDATE });
  const [row]: any = await sequelize.query(`SELECT * FROM internal_notes WHERE id = :id AND company_id = :companyId`, { replacements: { id, companyId }, type: QueryTypes.SELECT });
  return res.json(row || null);
});

aiRoutes.delete('/notes/:id', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const id = Number(req.params.id || 0);
  await sequelize.query(`DELETE FROM internal_notes WHERE id = :id AND company_id = :companyId`, { replacements: { id, companyId }, type: QueryTypes.DELETE });
  return res.json({ ok: true, deletedId: id });
});

aiRoutes.post('/templates/preview', isAuth, async (req: any, res) => {
  const template = String(req.body?.template || req.body?.content || '');
  const variables = req.body?.variables || {};
  return res.json({ rendered: renderTemplate(template, variables), missingVariables: Array.from(new Set((template.match(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g) || []).map((x) => x.replace(/[{}\s]/g, '')).filter((k) => variables?.[k] === undefined))) });
});

aiRoutes.get('/integrations/errors', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const source = String(req.query.source || '');
  const where = ['(company_id = :companyId OR company_id IS NULL)'];
  const replacements: any = { companyId };
  if (source) { where.push('source = :source'); replacements.source = source; }
  const rows = await sequelize.query(`SELECT * FROM integration_errors WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`, { replacements, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/integrations/errors/log', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const source = String(req.body?.source || '').toLowerCase() as any;
  if (!['whatsapp', 'meta', 'tokko'].includes(source)) return res.status(400).json({ error: 'source inválido' });
  await logIntegrationError({ companyId, source, severity: req.body?.severity || 'medium', errorCode: req.body?.errorCode, message: String(req.body?.message || 'integration error'), suggestion: req.body?.suggestion, payload: req.body?.payload || {} });
  return res.json({ ok: true });
});

aiRoutes.post('/leads/:contactId/recalculate-score', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId, id: userId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const [contact]: any = await sequelize.query(`SELECT id, name, email, number, tags, source, lead_score, "leadStatus" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`, { replacements: { contactId, companyId }, type: QueryTypes.SELECT });
  if (!contact) return res.status(404).json({ error: 'contacto no encontrado' });

  const interactions = Number.isFinite(Number(req.body?.interactions))
    ? Number(req.body?.interactions)
    : Number((await sequelize.query(`SELECT COUNT(*)::int AS qty FROM messages WHERE "contactId" = :contactId`, { replacements: { contactId }, type: QueryTypes.SELECT }) as any[])?.[0]?.qty || 0);
  const inactiveDays = Number.isFinite(Number(req.body?.inactiveDays))
    ? Number(req.body?.inactiveDays)
    : Number((await sequelize.query(`SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX("createdAt"), NOW()))) / 86400 AS days FROM messages WHERE "contactId" = :contactId`, { replacements: { contactId }, type: QueryTypes.SELECT }) as any[])?.[0]?.days || 0);
  const source = String(req.body?.source || contact.source || '');
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : parseTags(contact.tags);
  const newScore = scoreLead({ source, interactions, inactiveDays, tags });
  const leadStatus = newScore >= 75 ? 'hot' : newScore >= 50 ? 'warm' : newScore >= 25 ? 'engaged' : 'new';
  await sequelize.query(`UPDATE contacts SET lead_score = :leadScore, "leadStatus" = :leadStatus, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`, { replacements: { contactId, companyId, leadScore: newScore, leadStatus }, type: QueryTypes.UPDATE });
  await sequelize.query(`INSERT INTO lead_score_events (company_id, contact_id, previous_score, new_score, previous_status, new_status, reason, payload_json, created_by, created_at)
    VALUES (:companyId, :contactId, :previousScore, :newScore, :previousStatus, :newStatus, :reason, :payloadJson, :createdBy, NOW())`, {
    replacements: {
      companyId,
      contactId,
      previousScore: Number(contact.lead_score || 0),
      newScore,
      previousStatus: String(contact.leadStatus || contact.lead_status || 'new'),
      newStatus: leadStatus,
      reason: String(req.body?.reason || 'recalculate'),
      payloadJson: JSON.stringify({ source, interactions, inactiveDays, tags }),
      createdBy: userId || null
    },
    type: QueryTypes.INSERT
  });
  return res.json({ ok: true, contactId, leadScore: newScore, leadStatus, inputs: { source, interactions, inactiveDays, tags } });
});

aiRoutes.get('/leads/:contactId/score-history', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const rows = await sequelize.query(`SELECT id, previous_score, new_score, previous_status, new_status, reason, payload_json, created_by, created_at
    FROM lead_score_events WHERE company_id = :companyId AND contact_id = :contactId ORDER BY id DESC LIMIT 100`, {
    replacements: { companyId, contactId },
    type: QueryTypes.SELECT
  });
  return res.json(rows);
});

aiRoutes.get('/routing/rules', isAuth, async (_req: any, res) => {
  const runtime = getRuntimeSettings();
  let rules: any[] = [];
  try { rules = JSON.parse(runtime.routingRulesJson || '[]'); } catch {}
  return res.json({ rules });
});

aiRoutes.put('/routing/rules', isAuth, isAdmin, async (req: any, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const next = saveRuntimeSettings({ routingRulesJson: JSON.stringify(rules) });
  return res.json({ ok: true, rules: JSON.parse(next.routingRulesJson || '[]') });
});

aiRoutes.post('/routing/resolve', isAuth, async (req: any, res) => {
  const runtime = getRuntimeSettings();
  let rules: any[] = [];
  try { rules = JSON.parse(runtime.routingRulesJson || '[]'); } catch {}
  const source = String(req.body?.source || '').toLowerCase();
  const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).map((t: any) => String(t).toLowerCase());
  const channel = String(req.body?.channel || '').toLowerCase();
  const priority = Number(req.body?.priority || 0);
  const match = rules.find((r: any) => {
    if (r?.enabled === false) return false;
    if (r?.source && String(r.source).toLowerCase() !== source) return false;
    if (r?.channel && String(r.channel).toLowerCase() !== channel) return false;
    if (Number.isFinite(Number(r?.priorityMin)) && priority < Number(r.priorityMin)) return false;
    if (Array.isArray(r?.tagsAny) && r.tagsAny.length && !r.tagsAny.some((x: string) => tags.includes(String(x).toLowerCase()))) return false;
    return true;
  }) || null;
  return res.json({ matched: match, assignedUserId: match?.assignUserId || null, queue: match?.queue || null, routingKey: match?.key || null });
});

aiRoutes.post('/routing/execute', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const ticketId = Number(req.body?.ticketId || 0);
  const contactId = Number(req.body?.contactId || 0);
  if (!ticketId && !contactId) return res.status(400).json({ error: 'ticketId o contactId requerido' });

  const runtime = getRuntimeSettings();
  let rules: any[] = [];
  try { rules = JSON.parse(runtime.routingRulesJson || '[]'); } catch {}
  const source = String(req.body?.source || '').toLowerCase();
  const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).map((t: any) => String(t).toLowerCase());
  const channel = String(req.body?.channel || '').toLowerCase();
  const priority = Number(req.body?.priority || 0);
  const dryRun = String(req.body?.dryRun || '') === '1';

  const match = rules.find((r: any) => {
    if (r?.enabled === false) return false;
    if (r?.source && String(r.source).toLowerCase() !== source) return false;
    if (r?.channel && String(r.channel).toLowerCase() !== channel) return false;
    if (Number.isFinite(Number(r?.priorityMin)) && priority < Number(r.priorityMin)) return false;
    if (Array.isArray(r?.tagsAny) && r.tagsAny.length && !r.tagsAny.some((x: string) => tags.includes(String(x).toLowerCase()))) return false;
    return true;
  }) || null;

  if (!match) return res.json({ ok: true, applied: false, reason: 'no_rule_match' });
  if (dryRun) return res.json({ ok: true, applied: false, dryRun: true, matched: match, assignUserId: match?.assignUserId || null, queue: match?.queue || null });

  if (ticketId) {
    await sequelize.query(`UPDATE tickets SET "userId" = COALESCE(:userId, "userId"), queue = COALESCE(:queue, queue), "updatedAt" = NOW() WHERE id = :ticketId AND "companyId" = :companyId`, {
      replacements: { userId: Number(match?.assignUserId || 0) || null, queue: match?.queue ? String(match.queue) : null, ticketId, companyId },
      type: QueryTypes.UPDATE
    });
  }
  return res.json({ ok: true, applied: true, ticketId: ticketId || null, contactId: contactId || null, matched: match, assignUserId: match?.assignUserId || null, queue: match?.queue || null });
});

export const applyLeadStatusAndTokkoSync = async ({ companyId, contactId, status, lossReason }: { companyId: number; contactId: number; status: string; lossReason: string }) => {
  const normalizedStatus = status === 'perdido' ? 'lost' : status;
  const validStatus = ['lost', 'won', 'read', 'engaged', 'warm', 'hot', 'new'];
  if (!validStatus.includes(normalizedStatus)) return { error: 'status inválido', statusCode: 400 } as any;
  if (normalizedStatus === 'lost' && !lossReason) return { error: 'lossReason obligatorio para lead perdido', statusCode: 400 } as any;

  const [contact]: any = await sequelize.query(
    `SELECT id, name, number, email, needs FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`,
    { replacements: { contactId, companyId }, type: QueryTypes.SELECT }
  );
  if (!contact) return { error: 'contacto no encontrado', statusCode: 404 } as any;

  const mergedNeeds = [String(contact.needs || ''), lossReason ? `\n[LOSS_REASON] ${lossReason}` : ''].join('').slice(0, 900);
  await sequelize.query(
    `UPDATE contacts SET "leadStatus" = :leadStatus, needs = :needs, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`,
    {
      replacements: { contactId, companyId, leadStatus: normalizedStatus === 'won' ? 'customer' : normalizedStatus, needs: mergedNeeds },
      type: QueryTypes.UPDATE
    }
  );

  const tokkoStatusSync: any = await syncLeadStatusToTokko({
    name: String(contact.name || ''),
    phone: String(contact.number || '').replace(/\D/g, ''),
    email: String(contact.email || ''),
    status: normalizedStatus,
    lossReason,
    source: 'lead-close-status-sync'
  });

  if (tokkoStatusSync?.ok) {
    await ensureContactTag(Number(contactId), 'tokko_status_synced', '#0EA5E9');
  } else if (!tokkoStatusSync?.skipped) {
    await logIntegrationError({
      companyId,
      source: 'tokko',
      severity: 'medium',
      errorCode: 'TOKKO_STATUS_SYNC_FAILED',
      message: String(tokkoStatusSync?.error || `tokko status sync failed (${tokkoStatusSync?.status || 'n/a'})`),
      suggestion: 'Verificar configuración Tokko y endpoint webcontact',
      payload: { contactId, status: normalizedStatus, lossReason, result: tokkoStatusSync }
    });
  }

  return {
    ok: true,
    contactId,
    status: normalizedStatus,
    lossReason: lossReason || null,
    tokko: {
      synced: Boolean(tokkoStatusSync?.ok),
      skipped: Boolean(tokkoStatusSync?.skipped),
      statusCode: tokkoStatusSync?.status || null
    }
  };
};

const updateLeadStatusHandler = async (req: any, res: any) => {
  const { companyId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const status = String(req.body?.status || 'lost').toLowerCase();
  const lossReason = String(req.body?.lossReason || '').trim();

  const result = await applyLeadStatusAndTokkoSync({ companyId, contactId, status, lossReason });
  if (result?.error) return res.status(Number(result.statusCode || 400)).json({ error: result.error });
  return res.json(result);
};

aiRoutes.post('/leads/:contactId/close', isAuth, updateLeadStatusHandler);
aiRoutes.post('/leads/:contactId/status', isAuth, updateLeadStatusHandler);
aiRoutes.put('/contacts/:contactId/status', isAuth, updateLeadStatusHandler);

aiRoutes.get('/tokko/audit', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const sinceHours = Math.max(1, Math.min(24 * 30, Number(req.query?.sinceHours || 24 * 7)));

  const [sentTagCountRow]: any = await sequelize.query(
    `SELECT COUNT(DISTINCT ct."contactId")::int AS count
     FROM contact_tags ct
     JOIN tags t ON t.id = ct."tagId"
     JOIN contacts c ON c.id = ct."contactId"
     WHERE c."companyId" = :companyId
       AND LOWER(t.name) = 'enviado_tokko'`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  const [statusSyncedTagCountRow]: any = await sequelize.query(
    `SELECT COUNT(DISTINCT ct."contactId")::int AS count
     FROM contact_tags ct
     JOIN tags t ON t.id = ct."tagId"
     JOIN contacts c ON c.id = ct."contactId"
     WHERE c."companyId" = :companyId
       AND LOWER(t.name) = 'tokko_status_synced'`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  const [errorsCountRow]: any = await sequelize.query(
    `SELECT COUNT(*)::int AS count
     FROM integration_errors
     WHERE company_id = :companyId
       AND source = 'tokko'
       AND created_at >= NOW() - (:sinceHours::text || ' hours')::interval`,
    { replacements: { companyId, sinceHours }, type: QueryTypes.SELECT }
  );

  const recentErrors: any[] = await sequelize.query(
    `SELECT id, source, severity, error_code, message, suggestion, payload_json, created_at
     FROM integration_errors
     WHERE company_id = :companyId
       AND source = 'tokko'
     ORDER BY id DESC
     LIMIT 20`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  const [metaLeadsRow]: any = await sequelize.query(
    `SELECT COUNT(*)::int AS count
     FROM meta_lead_events
     WHERE company_id = :companyId
       AND created_at >= NOW() - (:sinceHours::text || ' hours')::interval`,
    { replacements: { companyId, sinceHours }, type: QueryTypes.SELECT }
  );

  return res.json({
    ok: true,
    sinceHours,
    totals: {
      metaLeadsInWindow: Number(metaLeadsRow?.count || 0),
      contactsTaggedEnviadoTokko: Number(sentTagCountRow?.count || 0),
      contactsTaggedTokkoStatusSynced: Number(statusSyncedTagCountRow?.count || 0),
      tokkoErrorsInWindow: Number(errorsCountRow?.count || 0)
    },
    recentErrors
  });
});

aiRoutes.post('/recapture/run-now', isAuth, async (_req: any, res: any) => {
  try {
    await CheckInactiveContactsService();
    return res.json({ ok: true, message: 'recapture scan executed' });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: String(error?.message || error || 'recapture_run_failed') });
  }
});

aiRoutes.post('/followups/schedule', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const ticketId = Number(req.body?.ticketId || 0) || null;
  const contactId = Number(req.body?.contactId || 0) || null;
  if (!ticketId && !contactId) return res.status(400).json({ error: 'ticketId o contactId requerido' });
  const runtime = getRuntimeSettings();
  let days = [1, 3, 7];
  try { days = (JSON.parse(runtime.followUpDaysJson || '[1,3,7]') || []).map((x: any) => Number(x)).filter((x: number) => x > 0); } catch {}
  const baseDate = req.body?.baseDate ? new Date(req.body.baseDate) : new Date();
  const sequenceGroup = String(req.body?.sequenceGroup || `${companyId}:${ticketId || 0}:${contactId || 0}:${baseDate.toISOString().slice(0, 10)}`);
  const idempotencyPrefix = String(req.body?.idempotencyKey || `${sequenceGroup}`);
  const created: any[] = [];
  const skipped: any[] = [];
  for (const day of days) {
    const scheduledAt = new Date(baseDate.getTime() + day * 24 * 60 * 60 * 1000);
    const idempotencyKey = `${idempotencyPrefix}:D+${day}`;
    const existing: any[] = await sequelize.query(`SELECT * FROM followup_sequences WHERE company_id = :companyId AND idempotency_key = :idempotencyKey LIMIT 1`, {
      replacements: { companyId, idempotencyKey },
      type: QueryTypes.SELECT
    });
    if (existing[0]) { skipped.push(existing[0]); continue; }
    const [row]: any = await sequelize.query(`INSERT INTO followup_sequences (company_id, ticket_id, contact_id, day_offset, template_text, status, scheduled_at, idempotency_key, sequence_group, created_at)
      VALUES (:companyId, :ticketId, :contactId, :dayOffset, :templateText, 'scheduled', :scheduledAt, :idempotencyKey, :sequenceGroup, NOW()) RETURNING *`, {
      replacements: { companyId, ticketId, contactId, dayOffset: day, templateText: `Seguimiento D+${day}` , scheduledAt, idempotencyKey, sequenceGroup },
      type: QueryTypes.INSERT
    });
    created.push(row);
  }
  return res.json({ ok: true, scheduled: created.length, skipped: skipped.length, sequenceGroup, items: created, existing: skipped });
});

aiRoutes.post('/followups/run-due', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const dryRun = String(req.body?.dryRun || '') === '1';
  const due: any[] = await sequelize.query(`SELECT * FROM followup_sequences WHERE company_id = :companyId AND status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 200`, { replacements: { companyId }, type: QueryTypes.SELECT });
  let executed = 0;
  if (!dryRun) {
    for (const row of due) {
      const [updated]: any = await sequelize.query(`UPDATE followup_sequences SET status = 'executed', executed_at = NOW() WHERE id = :id AND company_id = :companyId AND status = 'scheduled' RETURNING id`, { replacements: { id: Number(row.id), companyId }, type: QueryTypes.UPDATE });
      if (updated?.id) executed += 1;
    }
  }
  return res.json({ ok: true, dryRun, due: due.length, executed: dryRun ? 0 : executed, items: due });
});

aiRoutes.get('/followups', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const rows = await sequelize.query(`SELECT * FROM followup_sequences WHERE company_id = :companyId ORDER BY id DESC LIMIT 500`, { replacements: { companyId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

// Aliases for compatibility with UIs calling /sequences
aiRoutes.post('/sequences/schedule', isAuth, async (req: any, res) => {
  req.url = '/followups/schedule';
  return (aiRoutes as any).handle(req, res);
});
aiRoutes.post('/sequences/run-due', isAuth, async (req: any, res) => {
  req.url = '/followups/run-due';
  return (aiRoutes as any).handle(req, res);
});
aiRoutes.get('/sequences', isAuth, async (req: any, res) => {
  req.url = '/followups';
  return (aiRoutes as any).handle(req, res);
});

aiRoutes.get('/dedupe/candidates', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const rows = await sequelize.query(`
    WITH by_phone AS (
      SELECT 'phone'::text AS dedupe_key_type,
             REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g') AS dedupe_key,
             ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
             COUNT(*)::int AS qty
      FROM contacts c
      WHERE c."companyId" = :companyId
        AND REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g') <> ''
      GROUP BY REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g')
      HAVING COUNT(*) > 1
    ),
    by_email AS (
      SELECT 'email'::text AS dedupe_key_type,
             LOWER(TRIM(COALESCE(c.email,''))) AS dedupe_key,
             ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
             COUNT(*)::int AS qty
      FROM contacts c
      WHERE c."companyId" = :companyId
        AND LOWER(TRIM(COALESCE(c.email,''))) <> ''
      GROUP BY LOWER(TRIM(COALESCE(c.email,'')))
      HAVING COUNT(*) > 1
    )
    SELECT dedupe_key_type, dedupe_key, contact_ids, qty, (contact_ids[1]) AS primary_contact_id
    FROM (
      SELECT * FROM by_phone
      UNION ALL
      SELECT * FROM by_email
    ) z
    ORDER BY qty DESC, dedupe_key_type ASC
    LIMIT 200`, { replacements: { companyId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/dedupe/merge', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const primaryContactId = Number(req.body?.primaryContactId || 0);
  const secondaryContactId = Number(req.body?.secondaryContactId || 0);
  const force = String(req.body?.force || '') === '1';
  if (!primaryContactId || !secondaryContactId || primaryContactId === secondaryContactId) return res.status(400).json({ error: 'primaryContactId y secondaryContactId válidos son requeridos' });

  const runtime = getRuntimeSettings();
  const [primary]: any = await sequelize.query(`SELECT * FROM contacts WHERE id = :id AND "companyId" = :companyId LIMIT 1`, { replacements: { id: primaryContactId, companyId }, type: QueryTypes.SELECT });
  const [secondary]: any = await sequelize.query(`SELECT * FROM contacts WHERE id = :id AND "companyId" = :companyId LIMIT 1`, { replacements: { id: secondaryContactId, companyId }, type: QueryTypes.SELECT });
  if (!primary || !secondary) return res.status(404).json({ error: 'contacto no encontrado' });

  const samePhone = normalizePhone(primary.number) && normalizePhone(primary.number) === normalizePhone(secondary.number);
  const sameEmail = normalizeEmail(primary.email) && normalizeEmail(primary.email) === normalizeEmail(secondary.email);
  const hasMatch = samePhone || sameEmail;
  if (!hasMatch && !force) return res.status(422).json({ error: 'merge bloqueado: contactos sin key dedupe común (usar force=1 para override)' });
  if (runtime.dedupeStrictEmail && !sameEmail && !force) return res.status(422).json({ error: 'merge bloqueado por dedupeStrictEmail: emails no coinciden' });

  const tx = await sequelize.transaction();
  try {
    await sequelize.query(`UPDATE tickets SET "contactId" = :primaryId WHERE "contactId" = :secondaryId AND "companyId" = :companyId`, { replacements: { primaryId: primaryContactId, secondaryId: secondaryContactId, companyId }, type: QueryTypes.UPDATE, transaction: tx });
    await sequelize.query(`UPDATE messages SET "contactId" = :primaryId WHERE "contactId" = :secondaryId`, { replacements: { primaryId: primaryContactId, secondaryId: secondaryContactId }, type: QueryTypes.UPDATE, transaction: tx });
    await sequelize.query(`INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
      SELECT :primaryId, ct."tagId", NOW(), NOW() FROM contact_tags ct WHERE ct."contactId" = :secondaryId
      ON CONFLICT ("contactId", "tagId") DO NOTHING`, { replacements: { primaryId: primaryContactId, secondaryId: secondaryContactId }, type: QueryTypes.INSERT, transaction: tx });

    const mergedName = String(primary.name || secondary.name || '');
    const mergedEmail = String(primary.email || secondary.email || '');
    const mergedNumber = String(primary.number || secondary.number || '');
    const mergedNeeds = [String(primary.needs || ''), String(secondary.needs || '')].filter(Boolean).join('\n').slice(0, 900);
    const mergedLeadScore = Math.max(Number(primary.lead_score || 0), Number(secondary.lead_score || 0));
    await sequelize.query(`UPDATE contacts SET name = :name, email = :email, number = :number, needs = :needs, lead_score = :leadScore, "updatedAt" = NOW() WHERE id = :id AND "companyId" = :companyId`, { replacements: { id: primaryContactId, companyId, name: mergedName, email: mergedEmail, number: mergedNumber, needs: mergedNeeds, leadScore: mergedLeadScore }, type: QueryTypes.UPDATE, transaction: tx });
    await sequelize.query(`DELETE FROM contacts WHERE id = :id AND "companyId" = :companyId`, { replacements: { id: secondaryContactId, companyId }, type: QueryTypes.DELETE, transaction: tx });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return res.json({ ok: true, primaryContactId, mergedFrom: secondaryContactId, matchedBy: { samePhone, sameEmail }, forced: force });
});

export default aiRoutes;


