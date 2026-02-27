import fs from "fs";
import path from "path";

export interface RuntimeSettings {
  waCloudVerifyToken: string;
  waCloudPhoneNumberId: string;
  waCloudAccessToken: string;
  waCloudAppSecret: string;
  waCloudDefaultWhatsappId: number;
  waRecapEnabled: boolean;
  waRecapTemplateName: string;
  waRecapTemplateLang: string;
  waRecapInactivityMinutes: number;
  agentGuardrailsEnabled: boolean;
  agentConversationPoliciesJson: string;
  tokkoEnabled: boolean;
  tokkoApiKey: string;
  tokkoBaseUrl: string;
  tokkoLeadsPath: string;
  tokkoPropertiesPath: string;
  tokkoSyncLeadsEnabled: boolean;
  tokkoAgentSearchEnabled: boolean;
  tokkoSyncContactsEnabled: boolean;
  tokkoSyncContactTagsEnabled: boolean;
  tokkoFallbackToLocalSearch: boolean;
  tokkoDebugLogsEnabled: boolean;
  tokkoRateLimitEnabled: boolean;
  tokkoCooldownSeconds: number;
  tokkoSafeWriteMode: boolean;
  metaLeadAdsEnabled: boolean;
  metaLeadAdsWebhookVerifyToken: string;
  metaLeadAdsAppId: string;
  metaLeadAdsAppSecret: string;
  metaLeadAdsPageId: string;
  metaPropertyCarouselTemplateName: string;
  metaPropertyCarouselTemplateLanguage: string;
  tokkoTabVisible: boolean;
  slaEnabled: boolean;
  slaMinutes: number;
  slaAutoReassign: boolean;
  slaSuggestOnly: boolean;
  followUpEnabled: boolean;
  followUpDaysJson: string;
  routingRulesJson: string;
  dedupeStrictEmail: boolean;
  waOutboundDedupeTtlSeconds: number;
}

const FILE_PATH = path.resolve(process.cwd(), "runtime-settings.json");
const defaultPoliciesJson = JSON.stringify({
  sales: { maxReplyChars: 280, allowAutoClose: false, autoHandoffOnSensitive: false },
  support: { maxReplyChars: 320, allowAutoClose: false, autoHandoffOnSensitive: true },
  scheduling: { maxReplyChars: 220, allowAutoClose: true, autoHandoffOnSensitive: false },
  general: { maxReplyChars: 260, allowAutoClose: true, autoHandoffOnSensitive: false }
});
const defaultFollowUpDaysJson = JSON.stringify([1, 3, 7]);
const defaultRoutingRulesJson = JSON.stringify([]);

const readFileSettings = (): Partial<RuntimeSettings> => {
  try { if (!fs.existsSync(FILE_PATH)) return {}; return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8") || "{}"); } catch { return {}; }
};
const writeFileSettings = (settings: Partial<RuntimeSettings>) => fs.writeFileSync(FILE_PATH, JSON.stringify(settings, null, 2), "utf-8");
const parseBool = (v: any, fallback = false) => (typeof v === "boolean" ? v : (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()) : fallback));
const clampInt = (v: any, fallback: number, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

export const getRuntimeSettings = (): RuntimeSettings => {
  const fromFile = readFileSettings() as any;
  const recapEnabledFile = parseBool(fromFile.waRecapEnabled, false);
  const recapEnabledEnv = parseBool(process.env.WA_RECAP_ENABLED, false);
  return {
    waCloudVerifyToken: String(fromFile.waCloudVerifyToken || "") || process.env.WA_CLOUD_VERIFY_TOKEN || "",
    waCloudPhoneNumberId: String(fromFile.waCloudPhoneNumberId || "") || process.env.WA_CLOUD_PHONE_NUMBER_ID || "",
    waCloudAccessToken: String(fromFile.waCloudAccessToken || "") || process.env.WA_CLOUD_ACCESS_TOKEN || "",
    waCloudAppSecret: String(fromFile.waCloudAppSecret || "") || process.env.WA_CLOUD_APP_SECRET || "",
    waCloudDefaultWhatsappId: Number(fromFile.waCloudDefaultWhatsappId || process.env.WA_CLOUD_DEFAULT_WHATSAPP_ID || 1),
    waRecapEnabled: recapEnabledFile || recapEnabledEnv,
    waRecapTemplateName: String(fromFile.waRecapTemplateName || "") || process.env.WA_RECAP_TEMPLATE_NAME || "",
    waRecapTemplateLang: String(fromFile.waRecapTemplateLang || "") || process.env.WA_RECAP_TEMPLATE_LANG || "es_AR",
    waRecapInactivityMinutes: Number(fromFile.waRecapInactivityMinutes || process.env.WA_RECAP_INACTIVITY_MINUTES || 4320),
    agentGuardrailsEnabled: parseBool(fromFile.agentGuardrailsEnabled, true),
    agentConversationPoliciesJson: String(fromFile.agentConversationPoliciesJson || "") || defaultPoliciesJson,
    tokkoEnabled: parseBool(fromFile.tokkoEnabled, false),
    tokkoApiKey: String(fromFile.tokkoApiKey || "") || process.env.TOKKO_API_KEY || "",
    tokkoBaseUrl: String(fromFile.tokkoBaseUrl || "") || process.env.TOKKO_BASE_URL || "https://www.tokkobroker.com/api/v1",
    tokkoLeadsPath: String(fromFile.tokkoLeadsPath || "") || process.env.TOKKO_LEADS_PATH || "/webcontact/",
    tokkoPropertiesPath: String(fromFile.tokkoPropertiesPath || "") || process.env.TOKKO_PROPERTIES_PATH || "/property/",
    tokkoSyncLeadsEnabled: parseBool(fromFile.tokkoSyncLeadsEnabled, true),
    tokkoAgentSearchEnabled: parseBool(fromFile.tokkoAgentSearchEnabled, true),
    tokkoSyncContactsEnabled: parseBool(fromFile.tokkoSyncContactsEnabled, false),
    tokkoSyncContactTagsEnabled: parseBool(fromFile.tokkoSyncContactTagsEnabled, false),
    tokkoFallbackToLocalSearch: parseBool(fromFile.tokkoFallbackToLocalSearch, true),
    tokkoDebugLogsEnabled: parseBool(fromFile.tokkoDebugLogsEnabled, false),
    tokkoRateLimitEnabled: parseBool(fromFile.tokkoRateLimitEnabled, true),
    tokkoCooldownSeconds: Number(fromFile.tokkoCooldownSeconds || process.env.TOKKO_COOLDOWN_SECONDS || 10),
    tokkoSafeWriteMode: parseBool(fromFile.tokkoSafeWriteMode, true),
    metaLeadAdsEnabled: parseBool(fromFile.metaLeadAdsEnabled, false),
    metaLeadAdsWebhookVerifyToken: String(fromFile.metaLeadAdsWebhookVerifyToken || ''),
    metaLeadAdsAppId: String(fromFile.metaLeadAdsAppId || '') || process.env.META_LEAD_ADS_APP_ID || '',
    metaLeadAdsAppSecret: String(fromFile.metaLeadAdsAppSecret || '') || process.env.META_LEAD_ADS_APP_SECRET || '',
    metaLeadAdsPageId: String(fromFile.metaLeadAdsPageId || '') || process.env.META_LEAD_ADS_PAGE_ID || '',
    metaPropertyCarouselTemplateName: String(fromFile.metaPropertyCarouselTemplateName || '') || process.env.META_PROPERTY_CAROUSEL_TEMPLATE || 'propiedades_carrusel',
    metaPropertyCarouselTemplateLanguage: String(fromFile.metaPropertyCarouselTemplateLanguage || '') || process.env.META_PROPERTY_CAROUSEL_LANG || 'en_US',
    tokkoTabVisible: parseBool(fromFile.tokkoTabVisible, true),
    slaEnabled: parseBool(fromFile.slaEnabled, true),
    slaMinutes: Number(fromFile.slaMinutes || process.env.CRM_SLA_MINUTES || 60),
    slaAutoReassign: parseBool(fromFile.slaAutoReassign, false),
    slaSuggestOnly: parseBool(fromFile.slaSuggestOnly, true),
    followUpEnabled: parseBool(fromFile.followUpEnabled, true),
    followUpDaysJson: String(fromFile.followUpDaysJson || '') || defaultFollowUpDaysJson,
    routingRulesJson: String(fromFile.routingRulesJson || '') || defaultRoutingRulesJson,
    dedupeStrictEmail: parseBool(fromFile.dedupeStrictEmail, false),
    waOutboundDedupeTtlSeconds: clampInt(fromFile.waOutboundDedupeTtlSeconds || process.env.WA_OUTBOUND_DEDUPE_TTL_SECONDS || 120, 120, 30, 900)
  };
};

export const saveRuntimeSettings = (patch: Partial<RuntimeSettings>) => {
  const current = getRuntimeSettings();
  const next: RuntimeSettings = {
    ...current,
    ...patch,
    waCloudDefaultWhatsappId: Number(patch.waCloudDefaultWhatsappId || current.waCloudDefaultWhatsappId || 1),
    waRecapEnabled: typeof patch.waRecapEnabled === "boolean" ? patch.waRecapEnabled : current.waRecapEnabled,
    waRecapTemplateName: String(patch.waRecapTemplateName ?? current.waRecapTemplateName ?? ""),
    waRecapTemplateLang: String(patch.waRecapTemplateLang ?? current.waRecapTemplateLang ?? "es_AR"),
    waRecapInactivityMinutes: Number(patch.waRecapInactivityMinutes || current.waRecapInactivityMinutes || 4320),
    agentGuardrailsEnabled: typeof patch.agentGuardrailsEnabled === "boolean" ? patch.agentGuardrailsEnabled : current.agentGuardrailsEnabled,
    agentConversationPoliciesJson: String(patch.agentConversationPoliciesJson ?? current.agentConversationPoliciesJson ?? defaultPoliciesJson),
    tokkoEnabled: typeof patch.tokkoEnabled === "boolean" ? patch.tokkoEnabled : current.tokkoEnabled,
    tokkoApiKey: String(patch.tokkoApiKey ?? current.tokkoApiKey ?? ""),
    tokkoBaseUrl: String(patch.tokkoBaseUrl ?? current.tokkoBaseUrl ?? "https://www.tokkobroker.com/api/v1"),
    tokkoLeadsPath: String(patch.tokkoLeadsPath ?? current.tokkoLeadsPath ?? "/webcontact/"),
    tokkoPropertiesPath: String(patch.tokkoPropertiesPath ?? current.tokkoPropertiesPath ?? "/property/"),
    tokkoSyncLeadsEnabled: typeof patch.tokkoSyncLeadsEnabled === "boolean" ? patch.tokkoSyncLeadsEnabled : current.tokkoSyncLeadsEnabled,
    tokkoAgentSearchEnabled: typeof patch.tokkoAgentSearchEnabled === "boolean" ? patch.tokkoAgentSearchEnabled : current.tokkoAgentSearchEnabled,
    tokkoSyncContactsEnabled: typeof patch.tokkoSyncContactsEnabled === "boolean" ? patch.tokkoSyncContactsEnabled : current.tokkoSyncContactsEnabled,
    tokkoSyncContactTagsEnabled: typeof patch.tokkoSyncContactTagsEnabled === "boolean" ? patch.tokkoSyncContactTagsEnabled : current.tokkoSyncContactTagsEnabled,
    tokkoFallbackToLocalSearch: typeof patch.tokkoFallbackToLocalSearch === "boolean" ? patch.tokkoFallbackToLocalSearch : current.tokkoFallbackToLocalSearch,
    tokkoDebugLogsEnabled: typeof patch.tokkoDebugLogsEnabled === "boolean" ? patch.tokkoDebugLogsEnabled : current.tokkoDebugLogsEnabled,
    tokkoRateLimitEnabled: typeof patch.tokkoRateLimitEnabled === "boolean" ? patch.tokkoRateLimitEnabled : current.tokkoRateLimitEnabled,
    tokkoCooldownSeconds: Number(patch.tokkoCooldownSeconds || current.tokkoCooldownSeconds || 10),
    tokkoSafeWriteMode: typeof patch.tokkoSafeWriteMode === "boolean" ? patch.tokkoSafeWriteMode : current.tokkoSafeWriteMode,
    metaLeadAdsEnabled: typeof patch.metaLeadAdsEnabled === 'boolean' ? patch.metaLeadAdsEnabled : current.metaLeadAdsEnabled,
    metaLeadAdsWebhookVerifyToken: String(patch.metaLeadAdsWebhookVerifyToken ?? current.metaLeadAdsWebhookVerifyToken ?? ''),
    metaLeadAdsAppId: String(patch.metaLeadAdsAppId ?? current.metaLeadAdsAppId ?? ''),
    metaLeadAdsAppSecret: String(patch.metaLeadAdsAppSecret ?? current.metaLeadAdsAppSecret ?? ''),
    metaLeadAdsPageId: String(patch.metaLeadAdsPageId ?? current.metaLeadAdsPageId ?? ''),
    metaPropertyCarouselTemplateName: String(patch.metaPropertyCarouselTemplateName ?? current.metaPropertyCarouselTemplateName ?? 'propiedades_carrusel'),
    metaPropertyCarouselTemplateLanguage: String(patch.metaPropertyCarouselTemplateLanguage ?? current.metaPropertyCarouselTemplateLanguage ?? 'en_US'),
    tokkoTabVisible: typeof patch.tokkoTabVisible === 'boolean' ? patch.tokkoTabVisible : current.tokkoTabVisible,
    slaEnabled: typeof patch.slaEnabled === 'boolean' ? patch.slaEnabled : current.slaEnabled,
    slaMinutes: Number(patch.slaMinutes || current.slaMinutes || 60),
    slaAutoReassign: typeof patch.slaAutoReassign === 'boolean' ? patch.slaAutoReassign : current.slaAutoReassign,
    slaSuggestOnly: typeof patch.slaSuggestOnly === 'boolean' ? patch.slaSuggestOnly : current.slaSuggestOnly,
    followUpEnabled: typeof patch.followUpEnabled === 'boolean' ? patch.followUpEnabled : current.followUpEnabled,
    followUpDaysJson: String(patch.followUpDaysJson ?? current.followUpDaysJson ?? defaultFollowUpDaysJson),
    routingRulesJson: String(patch.routingRulesJson ?? current.routingRulesJson ?? defaultRoutingRulesJson),
    dedupeStrictEmail: typeof patch.dedupeStrictEmail === 'boolean' ? patch.dedupeStrictEmail : current.dedupeStrictEmail,
    waOutboundDedupeTtlSeconds: clampInt((patch as any).waOutboundDedupeTtlSeconds ?? current.waOutboundDedupeTtlSeconds ?? 120, 120, 30, 900)
  };
  writeFileSettings(next);
  return next;
};