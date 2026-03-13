import { Router } from "express";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import { getRuntimeSettings, saveRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";
const parseBoolWithDefault = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const parseNumberWithClamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = Number(value);
  const safe = Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.round(safe)));
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
import { getIntegrationHardeningAlertSnapshot, getIntegrationHardeningMetrics } from "./integrations/integrationRoutes";

const settingsRoutes = Router();
const maskKey = (key: string) => (!key ? "" : key.length <= 8 ? "*".repeat(key.length) : `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`);

settingsRoutes.get("/public", (req, res) => {
    const s = getRuntimeSettings() as any;
    return res.json({
        leadScoreHot: Number(s?.leadScoreHot) || 75,
        leadScoreWarm: Number(s?.leadScoreWarm) || 50,
        leadScoreContacted: Number(s?.leadScoreContacted) || 25,
        conversationPollIntervalMs: Number(s?.conversationPollIntervalMs) || 30000,
        dashboardPollIntervalMs: Number(s?.dashboardPollIntervalMs) || 60000,
    });
});

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
  const integrationApiAlerts = getIntegrationHardeningAlertSnapshot();
  const inboundWebhookAlerts = getWaHardeningAlertSnapshot();

  const integrationPendingAlerts = Array.isArray((integrationApiAlerts as any)?.pendingAlerts)
    ? (integrationApiAlerts as any).pendingAlerts
    : [];

  const inboundPendingAlerts = Array.isArray((inboundWebhookAlerts as any)?.pendingAlerts)
    ? (inboundWebhookAlerts as any).pendingAlerts
    : [];

  const hasMalformedIdempotencySpike = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_idempotency_key_malformed_spike"
  );

  const hasMismatchIdempotencySpike = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_idempotency_key_mismatch_spike"
  );

  const hasWeakIdempotencySpike = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_idempotency_key_weak_spike"
  );

  const hasOutboundDuplicateReplayRateHigh = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_duplicate_replay_rate_high"
  );

  const hasOutboundDuplicateInflightPressureHigh = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_duplicate_inflight_pressure_high"
  );

  const hasOutboundRetryWithoutIdempotencyKeyRateHigh = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_retry_without_idempotency_key_rate_high"
  );

  const hasOutboundReplayGuardFallbackPressure = integrationPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "outbound_integration_replay_guard_memory_fallback_used"
      || String(entry?.signal || "") === "outbound_integration_replay_guard_infra_error"
      || String(entry?.signal || "") === "outbound_integration_replay_guard_mark_done_infra_error"
      || String(entry?.signal || "") === "outbound_integration_replay_guard_clear_infra_error"
  );

  const hasInboundInvalidContentTypePressure = inboundPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "inbound_invalid_content_type_blocked"
      || String(entry?.signal || "") === "inbound_invalid_content_type_blocked_spike"
  );

  const hasInboundPayloadReplayPressure = inboundPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "inbound_payload_replay_blocked"
      || String(entry?.signal || "") === "inbound_replay_spike"
      || String(entry?.signal || "") === "inbound_replay_block_rate_high"
  );

  const hasInboundTimestampSkewPressure = inboundPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "inbound_timestamp_outside_allowed_skew"
      || String(entry?.signal || "") === "inbound_timestamp_outside_allowed_skew_spike"
  );

  const hasInboundReplayGuardFailClosedPressure = inboundPendingAlerts.some(
    (entry: any) => String(entry?.signal || "") === "inbound_payload_replay_guard_fail_closed_blocked"
  );

  const operationalRecommendations = [
    ...(hasMalformedIdempotencySpike
      ? ["Integración emite idempotency keys malformadas: normalizar a [a-zA-Z0-9:_-.], usar 8-64 chars y enviar SIEMPRE la misma key por retry del mismo mensaje."]
      : []),
    ...(hasMismatchIdempotencySpike
      ? ["Hay spike de idempotency key mismatch (header↔header / header↔body): unificar la fuente de verdad en el cliente y propagar exactamente la misma key en headers/body para el mismo request."]
      : []),
    ...(hasWeakIdempotencySpike
      ? ["Se detecta spike de idempotency keys débiles/cortas: generar UUID/ULID (o equivalente de alta entropía), evitar timestamps secuenciales y respetar mínimo de longitud configurado."]
      : []),
    ...(hasOutboundDuplicateReplayRateHigh
      ? ["La tasa de replay outbound está alta: consolidar retries del cliente sobre una única idempotency key por mensaje, evitar reenqueues paralelos y auditar por tenant los replays 200 duplicate=true para cortar bucles de reintento."]
      : []),
    ...(hasOutboundDuplicateInflightPressureHigh
      ? ["La presión de duplicados inflight está alta: aplicar backoff exponencial con jitter y single-flight por idempotency key para reducir colisiones mientras el envío previo sigue en proceso."]
      : []),
    ...(hasOutboundRetryWithoutIdempotencyKeyRateHigh
      ? ["Hay tasa alta de retries sin idempotency key en Integration API: persistir una key estable por envío lógico y reusarla en cada retry (timeouts, 5xx o cortes de conexión)."]
      : []),
    ...(hasOutboundReplayGuardFallbackPressure
      ? ["La Integration API está en fallback de replay guard (memoria o errores de persistencia): revisar salud DB/migraciones de ai_integration_outbound_replay_guard para mantener dedupe/idempotencia cross-restart y entre réplicas."]
      : []),
    ...(hasInboundInvalidContentTypePressure
      ? ["Se están bloqueando webhooks por Content-Type inválido: asegurar application/json en Meta/proxy (sin transformaciones) para evitar 415 y pérdida de eventos."]
      : []),
    ...(hasInboundPayloadReplayPressure
      ? ["Hay presión de replay inbound: revisar reintentos duplicados aguas arriba y validar que cada entrega conserve firma/cuerpo consistentes para dedupe estable."]
      : []),
    ...(hasInboundTimestampSkewPressure
      ? ["Hay bloqueos por timestamp fuera de ventana inbound: verificar NTP/clock skew en productores y latencia de colas/reintentos para evitar descartes legítimos por stale/future timestamps."]
      : []),
    ...(hasInboundReplayGuardFailClosedPressure
      ? ["El replay guard inbound entró en fail-closed: priorizar salud DB/migraciones de ai_webhook_payload_replay_guard para no bloquear eventos legítimos."]
      : [])
  ];

  const primaryOperationalRecommendation = operationalRecommendations[0] || null;
  const primaryOperationalSignal = hasMalformedIdempotencySpike
    ? "outbound_integration_idempotency_key_malformed_spike"
    : hasMismatchIdempotencySpike
      ? "outbound_integration_idempotency_key_mismatch_spike"
      : hasWeakIdempotencySpike
        ? "outbound_integration_idempotency_key_weak_spike"
        : hasOutboundDuplicateReplayRateHigh
          ? "outbound_integration_duplicate_replay_rate_high"
          : hasOutboundDuplicateInflightPressureHigh
            ? "outbound_integration_duplicate_inflight_pressure_high"
            : hasOutboundRetryWithoutIdempotencyKeyRateHigh
              ? "outbound_integration_retry_without_idempotency_key_rate_high"
              : hasOutboundReplayGuardFallbackPressure
                ? "outbound_integration_replay_guard_memory_fallback_used"
                : hasInboundInvalidContentTypePressure
                  ? "inbound_invalid_content_type_blocked_spike"
                  : hasInboundPayloadReplayPressure
                    ? "inbound_replay_spike"
                    : hasInboundTimestampSkewPressure
                      ? "inbound_timestamp_outside_allowed_skew"
                      : hasInboundReplayGuardFailClosedPressure
                        ? "inbound_payload_replay_guard_fail_closed_blocked"
                        : null;

  return res.json({
    effectiveConfig: {
      waOutboundDedupeTtlSeconds: Number(settings.waOutboundDedupeTtlSeconds || 120),
      waOutboundDedupeFailClosed: boolWithDefault((settings as any).waOutboundDedupeFailClosed, true),
      waOutboundRetryMaxAttempts: Number(settings.waOutboundRetryMaxAttempts || 3),
      waOutboundRetryMaxDelayMs: Number((settings as any).waOutboundRetryMaxDelayMs || 15000),
      waOutboundRetryOnTimeout: boolWithDefault((settings as any).waOutboundRetryOnTimeout, false),
      waOutboundRetryRequireIdempotencyKey: boolWithDefault((settings as any).waOutboundRetryRequireIdempotencyKey, true),
      waOutboundAllowRetryWithoutIdempotencyKey: boolWithDefault((settings as any).waOutboundAllowRetryWithoutIdempotencyKey, false),
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
      waWebhookSignatureHeaderMaxLength: Number((settings as any).waWebhookSignatureHeaderMaxLength || 200),
      waWebhookSignatureInvalidRateLimitWindowSeconds: Number((settings as any).waWebhookSignatureInvalidRateLimitWindowSeconds || 60),
      waWebhookSignatureInvalidRateLimitMaxHits: Number((settings as any).waWebhookSignatureInvalidRateLimitMaxHits || 8),
      waWebhookForwardedForHeaderMaxLength: parseNumberWithClamp((settings as any).waWebhookForwardedForHeaderMaxLength, 2048, 256, 8192),
      waWebhookPayloadReplayKeyReuseWindowSeconds: parseNumberWithClamp((settings as any).waWebhookPayloadReplayKeyReuseWindowSeconds, 600, 30, 3600),
      waWebhookPayloadReplayKeyReuseThreshold: parseNumberWithClamp((settings as any).waWebhookPayloadReplayKeyReuseThreshold, 3, 1, 20),
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
      outboundIntegrationApi: integrationApiAlerts
    },
    recommendations: {
      primaryOperational: primaryOperationalRecommendation,
      primaryOperationalSignal,
      operational: operationalRecommendations
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
    tokkoSyncLeadsEnabled: typeof body.tokkoEnabled === "boolean" ? body.tokkoEnabled : true,
    tokkoAgentSearchEnabled: typeof body.tokkoEnabled === "boolean" ? body.tokkoEnabled : true,
    tokkoSyncContactsEnabled: typeof body.tokkoEnabled === "boolean" ? body.tokkoEnabled : true,
    tokkoSyncContactTagsEnabled: typeof body.tokkoEnabled === "boolean" ? body.tokkoEnabled : true,
    tokkoFallbackToLocalSearch: true,
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
    waOutboundAllowRetryWithoutIdempotencyKey: typeof body.waOutboundAllowRetryWithoutIdempotencyKey === "boolean" ? body.waOutboundAllowRetryWithoutIdempotencyKey : false,
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
    waWebhookSignatureHeaderMaxLength: Number(body.waWebhookSignatureHeaderMaxLength || 200),
    waWebhookSignatureInvalidRateLimitWindowSeconds: Number(body.waWebhookSignatureInvalidRateLimitWindowSeconds || 60),
    waWebhookSignatureInvalidRateLimitMaxHits: Number(body.waWebhookSignatureInvalidRateLimitMaxHits || 8),
    waWebhookForwardedForHeaderMaxLength: parseNumberWithClamp(body.waWebhookForwardedForHeaderMaxLength, 2048, 256, 8192),
    waWebhookPayloadReplayKeyReuseWindowSeconds: parseNumberWithClamp(body.waWebhookPayloadReplayKeyReuseWindowSeconds, 600, 30, 3600),
    waWebhookPayloadReplayKeyReuseThreshold: parseNumberWithClamp(body.waWebhookPayloadReplayKeyReuseThreshold, 3, 1, 20),
    waOutboundDedupeMemoryMaxEntries: Number(body.waOutboundDedupeMemoryMaxEntries || 5000)
  });
  const {
    waCloudVerifyToken: _vt,
    waCloudAccessToken: _at,
    waCloudAppSecret: _as,
    tokkoApiKey: _tk,
    metaLeadAdsAppSecret: _ms,
    ...safeNext
  } = next as any;
  return res.json({ ok: true, settings: safeNext });
});

export default settingsRoutes;