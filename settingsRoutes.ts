import { Router } from "express";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import { getRuntimeSettings, saveRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";
const parseBoolWithDefault = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const getWaHardeningMetrics = () => {
  const s = getRuntimeSettings() as any;
  const appSecretConfigured = Boolean(String(s.waCloudAppSecret || "").trim());
  const allowUnsignedWebhook = parseBoolWithDefault(s.waWebhookAllowUnsigned, false);
  const replayFailClosed = parseBoolWithDefault(s.waWebhookPayloadReplayFailClosed, true);

  return {
    runtime: {
      appSecretConfigured,
      allowUnsignedWebhook,
      insecureUnsignedWebhookAllowed: allowUnsignedWebhook,
      replayFailClosed,
      insecureReplayGuardFailOpen: !replayFailClosed
    }
  } as any;
};

const getWaHardeningAlertSnapshot = () => {
  const s = getRuntimeSettings() as any;
  const appSecretConfigured = Boolean(String(s.waCloudAppSecret || "").trim());
  const allowUnsignedWebhook = parseBoolWithDefault(s.waWebhookAllowUnsigned, false);
  const replayFailClosed = parseBoolWithDefault(s.waWebhookPayloadReplayFailClosed, true);

  const pendingAlerts: any[] = [];

  if (allowUnsignedWebhook) {
    pendingAlerts.push({
      signal: "inbound_unsigned_webhook_allowed",
      threshold: 1,
      inWindow: 1,
      remaining: 0,
      severity: "warn",
      source: "runtime_settings"
    });
  }

  if (!appSecretConfigured) {
    pendingAlerts.push({
      signal: "inbound_webhook_app_secret_missing",
      threshold: 1,
      inWindow: 1,
      remaining: 0,
      severity: allowUnsignedWebhook ? "critical" : "warn",
      source: "runtime_settings"
    });
  }

  if (!replayFailClosed) {
    pendingAlerts.push({
      signal: "inbound_payload_replay_fail_open",
      threshold: 1,
      inWindow: 1,
      remaining: 0,
      severity: "warn",
      source: "runtime_settings"
    });
  }

  return {
    windowMs: 0,
    pendingAlerts
  } as any;
};
import { getSendHardeningAlertSnapshot, getSendHardeningMetrics } from "../services/MessageServices/SendMessageService";
import { getIntegrationHardeningAlertSnapshot, getIntegrationHardeningMetrics } from "./integrationRoutes";

const settingsRoutes = Router();
const maskKey = (key: string) => (!key ? "" : key.length <= 8 ? "*".repeat(key.length) : `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`);

settingsRoutes.get("/integrations/api-key", isAuth, isAdmin, async (_req, res) => {
  const apiKey = process.env.INTEGRATIONS_API_KEY || "";
  return res.json({ configured: Boolean(apiKey), apiKeyMasked: apiKey ? maskKey(apiKey) : "" });
});

settingsRoutes.get("/whatsapp-cloud", isAuth, isAdmin, async (_req, res) => {
  const settings = getRuntimeSettings();
  const {
    waCloudVerifyToken,
    waCloudAccessToken,
    waCloudAppSecret,
    tokkoApiKey,
    metaLeadAdsAppSecret,
    ...safeSettings
  } = settings as any;

  return res.json({
    configured: {
      verifyToken: Boolean(waCloudVerifyToken),
      phoneNumberId: Boolean(settings.waCloudPhoneNumberId),
      accessToken: Boolean(waCloudAccessToken),
      appSecret: Boolean(waCloudAppSecret),
      recapTemplate: Boolean(settings.waRecapTemplateName),
      tokkoApiKey: Boolean(tokkoApiKey),
      metaLeadAdsAppSecret: Boolean(metaLeadAdsAppSecret)
    },
    settings: {
      ...safeSettings,
      waCloudVerifyTokenMasked: waCloudVerifyToken ? maskKey(waCloudVerifyToken) : "",
      waCloudAccessTokenMasked: waCloudAccessToken ? maskKey(waCloudAccessToken) : "",
      waCloudAppSecretMasked: waCloudAppSecret ? maskKey(waCloudAppSecret) : "",
      tokkoApiKeyMasked: tokkoApiKey ? maskKey(tokkoApiKey) : "",
      metaLeadAdsAppSecretMasked: metaLeadAdsAppSecret ? maskKey(metaLeadAdsAppSecret) : ""
    }
  });
});

settingsRoutes.get("/meta/webhook-status", isAuth, isAdmin, async (_req, res) => {
  const s = getRuntimeSettings();
  return res.json({
    enabled: Boolean(s.metaLeadAdsEnabled),
    verifyTokenConfigured: Boolean(s.metaLeadAdsWebhookVerifyToken),
    appIdConfigured: Boolean(s.metaLeadAdsAppId),
    appSecretConfigured: Boolean(s.metaLeadAdsAppSecret),
    pageIdConfigured: Boolean(s.metaLeadAdsPageId),
    callbackUrl: `${process.env.BACKEND_URL || ""}/api/ai/meta-leads/webhook`
  });
});

settingsRoutes.get("/whatsapp-cloud/hardening-status", isAuth, isAdmin, async (_req, res) => {
  const settings = getRuntimeSettings();
  const boolWithDefault = parseBoolWithDefault;

  return res.json({
    effectiveConfig: {
      waOutboundDedupeTtlSeconds: Number(settings.waOutboundDedupeTtlSeconds || 120),
      waOutboundDedupeFailClosed: boolWithDefault((settings as any).waOutboundDedupeFailClosed, true),
      waOutboundRetryMaxAttempts: Number(settings.waOutboundRetryMaxAttempts || 3),
      waOutboundRetryMaxDelayMs: Number((settings as any).waOutboundRetryMaxDelayMs || 15000),
      waOutboundRetryOnTimeout: boolWithDefault((settings as any).waOutboundRetryOnTimeout, false),
      waOutboundRetryRequireIdempotencyKey: boolWithDefault((settings as any).waOutboundRetryRequireIdempotencyKey, true),
      waManagedReplyRetryRequireIdempotencyKey: boolWithDefault((settings as any).waManagedReplyRetryRequireIdempotencyKey, true),
      waOutboundRequireIdempotencyKey: boolWithDefault((settings as any).waOutboundRequireIdempotencyKey, true),
      waOutboundIdempotencyKeyMinLength: Number((settings as any).waOutboundIdempotencyKeyMinLength || 8),
      waOutboundRequestTimeoutMs: Number((settings as any).waOutboundRequestTimeoutMs || 12000),
      waFirstContactHolaTemplateRequired: boolWithDefault((settings as any).waFirstContactHolaTemplateRequired, true),
      waInboundReplayTtlSeconds: Number(settings.waInboundReplayTtlSeconds || 86400),
      waInboundReplayMaxBlocksPerPayload: Number(settings.waInboundReplayMaxBlocksPerPayload || 40),
      waWebhookPayloadReplayTtlSeconds: Number((settings as any).waWebhookPayloadReplayTtlSeconds || 120),
      waWebhookPayloadReplayCacheMaxEntries: Number((settings as any).waWebhookPayloadReplayCacheMaxEntries || 5000),
      waWebhookPayloadReplayFailClosed: boolWithDefault((settings as any).waWebhookPayloadReplayFailClosed, true),
      waWebhookAllowUnsigned: boolWithDefault((settings as any).waWebhookAllowUnsigned, false),
      waWebhookMaxBodyBytes: Number((settings as any).waWebhookMaxBodyBytes || 262144),
      waWebhookSignatureInvalidRateLimitWindowSeconds: Number((settings as any).waWebhookSignatureInvalidRateLimitWindowSeconds || 60),
      waWebhookSignatureInvalidRateLimitMaxHits: Number((settings as any).waWebhookSignatureInvalidRateLimitMaxHits || 8),
      waOutboundDedupeMemoryMaxEntries: Number((settings as any).waOutboundDedupeMemoryMaxEntries || 5000)
    },
    metrics: {
      inboundWebhook: getWaHardeningMetrics(),
      outboundSend: getSendHardeningMetrics(),
      outboundIntegrationApi: getIntegrationHardeningMetrics()
    },
    alerts: {
      inboundWebhook: getWaHardeningAlertSnapshot(),
      outboundSend: getSendHardeningAlertSnapshot(),
      outboundIntegrationApi: getIntegrationHardeningAlertSnapshot()
    }
  });
});

settingsRoutes.put("/whatsapp-cloud", isAuth, isAdmin, async (req, res) => {
  const body = req.body || {};
  const next = saveRuntimeSettings({
    waCloudVerifyToken: String(body.waCloudVerifyToken ?? ""),
    waCloudPhoneNumberId: String(body.waCloudPhoneNumberId ?? ""),
    waCloudAccessToken: String(body.waCloudAccessToken ?? ""),
    waCloudAppSecret: String(body.waCloudAppSecret ?? ""),
    waCloudDefaultWhatsappId: Number(body.waCloudDefaultWhatsappId || 1),
    waRecapEnabled: typeof body.waRecapEnabled === "boolean" ? body.waRecapEnabled : false,
    waRecapTemplateName: String(body.waRecapTemplateName ?? ""),
    waRecapTemplateLang: String(body.waRecapTemplateLang ?? "es_AR"),
    waRecapInactivityMinutes: Number(body.waRecapInactivityMinutes || 4320),
    agentGuardrailsEnabled: typeof body.agentGuardrailsEnabled === "boolean" ? body.agentGuardrailsEnabled : true,
    agentConversationPoliciesJson: String(body.agentConversationPoliciesJson ?? ""),
    tokkoEnabled: typeof body.tokkoEnabled === "boolean" ? body.tokkoEnabled : false,
    tokkoApiKey: String(body.tokkoApiKey ?? ""),
    tokkoBaseUrl: String(body.tokkoBaseUrl ?? "https://www.tokkobroker.com/api/v1"),
    tokkoLeadsPath: String(body.tokkoLeadsPath ?? "/webcontact/"),
    tokkoPropertiesPath: String(body.tokkoPropertiesPath ?? "/property/"),
    tokkoSyncLeadsEnabled: typeof body.tokkoSyncLeadsEnabled === "boolean" ? body.tokkoSyncLeadsEnabled : true,
    tokkoAgentSearchEnabled: typeof body.tokkoAgentSearchEnabled === "boolean" ? body.tokkoAgentSearchEnabled : true,
    tokkoSyncContactsEnabled: typeof body.tokkoSyncContactsEnabled === "boolean" ? body.tokkoSyncContactsEnabled : false,
    tokkoSyncContactTagsEnabled: typeof body.tokkoSyncContactTagsEnabled === "boolean" ? body.tokkoSyncContactTagsEnabled : false,
    tokkoFallbackToLocalSearch: typeof body.tokkoFallbackToLocalSearch === "boolean" ? body.tokkoFallbackToLocalSearch : true,
    tokkoDebugLogsEnabled: typeof body.tokkoDebugLogsEnabled === "boolean" ? body.tokkoDebugLogsEnabled : false,
    tokkoRateLimitEnabled: typeof body.tokkoRateLimitEnabled === "boolean" ? body.tokkoRateLimitEnabled : true,
    tokkoCooldownSeconds: Number(body.tokkoCooldownSeconds || 10),
    tokkoSafeWriteMode: typeof body.tokkoSafeWriteMode === "boolean" ? body.tokkoSafeWriteMode : true,
    metaLeadAdsEnabled: typeof body.metaLeadAdsEnabled === "boolean" ? body.metaLeadAdsEnabled : false,
    metaLeadAdsWebhookVerifyToken: String(body.metaLeadAdsWebhookVerifyToken ?? ""),
    metaLeadAdsAppId: String(body.metaLeadAdsAppId ?? ""),
    metaLeadAdsAppSecret: String(body.metaLeadAdsAppSecret ?? ""),
    metaLeadAdsPageId: String(body.metaLeadAdsPageId ?? ""),
    tokkoTabVisible: typeof body.tokkoTabVisible === "boolean" ? body.tokkoTabVisible : true,
    slaEnabled: typeof body.slaEnabled === "boolean" ? body.slaEnabled : true,
    slaMinutes: Number(body.slaMinutes || 60),
    slaAutoReassign: typeof body.slaAutoReassign === "boolean" ? body.slaAutoReassign : false,
    slaSuggestOnly: typeof body.slaSuggestOnly === "boolean" ? body.slaSuggestOnly : true,
    followUpEnabled: typeof body.followUpEnabled === "boolean" ? body.followUpEnabled : true,
    followUpDaysJson: String(body.followUpDaysJson ?? "[1,3,7]"),
    routingRulesJson: String(body.routingRulesJson ?? "[]"),
    dedupeStrictEmail: typeof body.dedupeStrictEmail === "boolean" ? body.dedupeStrictEmail : false,
    waOutboundDedupeTtlSeconds: Number(body.waOutboundDedupeTtlSeconds || 120),
    waOutboundDedupeFailClosed: typeof body.waOutboundDedupeFailClosed === "boolean" ? body.waOutboundDedupeFailClosed : true,
    waOutboundRetryMaxAttempts: Number(body.waOutboundRetryMaxAttempts || 3),
    waOutboundRetryMaxDelayMs: Number(body.waOutboundRetryMaxDelayMs || 15000),
    waOutboundRetryOnTimeout: typeof body.waOutboundRetryOnTimeout === "boolean" ? body.waOutboundRetryOnTimeout : false,
    waOutboundRetryRequireIdempotencyKey: typeof body.waOutboundRetryRequireIdempotencyKey === "boolean" ? body.waOutboundRetryRequireIdempotencyKey : true,
    waManagedReplyRetryRequireIdempotencyKey: typeof body.waManagedReplyRetryRequireIdempotencyKey === "boolean" ? body.waManagedReplyRetryRequireIdempotencyKey : true,
    waOutboundRequireIdempotencyKey: typeof body.waOutboundRequireIdempotencyKey === "boolean" ? body.waOutboundRequireIdempotencyKey : true,
    waOutboundIdempotencyKeyMinLength: Number(body.waOutboundIdempotencyKeyMinLength || 8),
    waOutboundRequestTimeoutMs: Number(body.waOutboundRequestTimeoutMs || 12000),
    waFirstContactHolaTemplateRequired: typeof body.waFirstContactHolaTemplateRequired === "boolean" ? body.waFirstContactHolaTemplateRequired : true,
    waInboundReplayTtlSeconds: Number(body.waInboundReplayTtlSeconds || 86400),
    waInboundReplayMaxBlocksPerPayload: Number(body.waInboundReplayMaxBlocksPerPayload || 40),
    waWebhookPayloadReplayTtlSeconds: Number(body.waWebhookPayloadReplayTtlSeconds || 120),
    waWebhookPayloadReplayCacheMaxEntries: Number(body.waWebhookPayloadReplayCacheMaxEntries || 5000),
    waWebhookPayloadReplayFailClosed: typeof body.waWebhookPayloadReplayFailClosed === "boolean" ? body.waWebhookPayloadReplayFailClosed : true,
    waWebhookAllowUnsigned: typeof body.waWebhookAllowUnsigned === "boolean" ? body.waWebhookAllowUnsigned : false,
    waWebhookMaxBodyBytes: Number(body.waWebhookMaxBodyBytes || 262144),
    waWebhookSignatureInvalidRateLimitWindowSeconds: Number(body.waWebhookSignatureInvalidRateLimitWindowSeconds || 60),
    waWebhookSignatureInvalidRateLimitMaxHits: Number(body.waWebhookSignatureInvalidRateLimitMaxHits || 8),
    waOutboundDedupeMemoryMaxEntries: Number(body.waOutboundDedupeMemoryMaxEntries || 5000)
  });
  return res.json({ ok: true, settings: next });
});

export default settingsRoutes;