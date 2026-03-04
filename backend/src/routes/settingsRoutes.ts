import { Router } from 'express';
import isAuth from '../middleware/isAuth';
import { getRuntimeSettings, saveRuntimeSettings, getRuntimeSettingsForCompany, saveRuntimeSettingsForCompany } from '../services/SettingsServices/RuntimeSettingsService';
import Company from '../models/Company';
import { syncTokkoLocationsToKnowledge } from '../services/TokkoServices/TokkoService';

const settingsRoutes = Router();

const maskKey = (key: string) => {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + "*".repeat(Math.max(4, key.length - 8)) + key.slice(-4);
};

settingsRoutes.get('/whatsapp-cloud', isAuth, async (req: any, res) => {
  const companyId = Number(req.user?.companyId || 0);
  const s = await getRuntimeSettingsForCompany(companyId);
  return res.json({
    settings: {
      ...s,
      waCloudAccessToken: '',
      waCloudAppSecret: '',
      tokkoApiKey: '',
      metaLeadAdsAppSecret: '',
      waCloudAccessTokenMasked: s.waCloudAccessToken ? maskKey(s.waCloudAccessToken) : '',
      waCloudAppSecretMasked: s.waCloudAppSecret ? maskKey(s.waCloudAppSecret) : '',
      tokkoApiKeyMasked: s.tokkoApiKey ? maskKey(s.tokkoApiKey) : '',
      metaLeadAdsWebhookVerifyTokenMasked: s.metaLeadAdsWebhookVerifyToken ? maskKey(s.metaLeadAdsWebhookVerifyToken) : '',
      metaLeadAdsAppSecretMasked: s.metaLeadAdsAppSecret ? maskKey(s.metaLeadAdsAppSecret) : ''
    }
  });
});

settingsRoutes.put('/whatsapp-cloud', isAuth, async (req: any, res) => {
  const companyId = Number(req.user?.companyId || 0);
  const body = req.body || {};
  const prev = await getRuntimeSettingsForCompany(companyId);
  const next = await saveRuntimeSettingsForCompany(companyId, {
    waCloudVerifyToken: String(body.waCloudVerifyToken ?? ''),
    waCloudPhoneNumberId: String(body.waCloudPhoneNumberId ?? ''),
    waCloudAccessToken: String(body.waCloudAccessToken ?? ''),
    waCloudAppSecret: String(body.waCloudAppSecret ?? ''),
    waCloudDefaultWhatsappId: Number(body.waCloudDefaultWhatsappId || 1),

    waRecapEnabled: typeof body.waRecapEnabled === 'boolean' ? body.waRecapEnabled : undefined,
    waRecapTemplateName: String(body.waRecapTemplateName ?? ''),
    waRecapTemplateLang: String(body.waRecapTemplateLang ?? ''),
    waRecapInactivityMinutes: Number(body.waRecapInactivityMinutes || 4320),

    agentGuardrailsEnabled: typeof body.agentGuardrailsEnabled === 'boolean' ? body.agentGuardrailsEnabled : undefined,
    agentConversationPoliciesJson: String(body.agentConversationPoliciesJson ?? ''),

    tokkoEnabled: typeof body.tokkoEnabled === 'boolean' ? body.tokkoEnabled : undefined,
    tokkoApiKey: String(body.tokkoApiKey ?? ''),
    tokkoBaseUrl: String(body.tokkoBaseUrl ?? ''),
    tokkoLeadsPath: String(body.tokkoLeadsPath ?? ''),
    tokkoPropertiesPath: String(body.tokkoPropertiesPath ?? ''),
    tokkoSyncLeadsEnabled: typeof body.tokkoSyncLeadsEnabled === 'boolean' ? body.tokkoSyncLeadsEnabled : undefined,
    tokkoAgentSearchEnabled: typeof body.tokkoAgentSearchEnabled === 'boolean' ? body.tokkoAgentSearchEnabled : undefined,
    tokkoSyncContactsEnabled: typeof body.tokkoSyncContactsEnabled === 'boolean' ? body.tokkoSyncContactsEnabled : undefined,
    tokkoSyncContactTagsEnabled: typeof body.tokkoSyncContactTagsEnabled === 'boolean' ? body.tokkoSyncContactTagsEnabled : undefined,
    tokkoFallbackToLocalSearch: typeof body.tokkoFallbackToLocalSearch === 'boolean' ? body.tokkoFallbackToLocalSearch : undefined,
    tokkoDebugLogsEnabled: typeof body.tokkoDebugLogsEnabled === 'boolean' ? body.tokkoDebugLogsEnabled : undefined,
    tokkoRateLimitEnabled: typeof body.tokkoRateLimitEnabled === 'boolean' ? body.tokkoRateLimitEnabled : undefined,
    tokkoCooldownSeconds: Number(body.tokkoCooldownSeconds || 10),
    tokkoSafeWriteMode: typeof body.tokkoSafeWriteMode === 'boolean' ? body.tokkoSafeWriteMode : undefined,
    tokkoTabVisible: typeof body.tokkoTabVisible === 'boolean' ? body.tokkoTabVisible : undefined,

    metaLeadAdsEnabled: typeof body.metaLeadAdsEnabled === 'boolean' ? body.metaLeadAdsEnabled : undefined,
    metaLeadAdsWebhookVerifyToken: String(body.metaLeadAdsWebhookVerifyToken ?? ''),
    metaLeadAdsAppId: String(body.metaLeadAdsAppId ?? ''),
    metaLeadAdsAppSecret: String(body.metaLeadAdsAppSecret ?? ''),
    metaLeadAdsPageId: String(body.metaLeadAdsPageId ?? ''),
    metaPropertyCarouselTemplateName: String(body.metaPropertyCarouselTemplateName ?? ''),
    metaPropertyCarouselTemplateLanguage: String(body.metaPropertyCarouselTemplateLanguage ?? ''),

    slaEnabled: typeof body.slaEnabled === 'boolean' ? body.slaEnabled : undefined,
    slaMinutes: Number(body.slaMinutes || 60),
    slaAutoReassign: typeof body.slaAutoReassign === 'boolean' ? body.slaAutoReassign : undefined,
    slaSuggestOnly: typeof body.slaSuggestOnly === 'boolean' ? body.slaSuggestOnly : undefined,
    followUpEnabled: typeof body.followUpEnabled === 'boolean' ? body.followUpEnabled : undefined,
    followUpDaysJson: String(body.followUpDaysJson ?? ''),
    routingRulesJson: String(body.routingRulesJson ?? ''),
    dedupeStrictEmail: typeof body.dedupeStrictEmail === 'boolean' ? body.dedupeStrictEmail : undefined,
    waOutboundDedupeTtlSeconds: Number(body.waOutboundDedupeTtlSeconds || 120)
  } as any);



  let tokkoKnowledgeSync: any = null;
  try {
    const tokkoJustEnabled = !prev.tokkoEnabled && Boolean(next.tokkoEnabled);
    const tokkoCredentialsUpdated =
      String(prev.tokkoApiKey || '') !== String(next.tokkoApiKey || '') ||
      String(prev.tokkoBaseUrl || '') !== String(next.tokkoBaseUrl || '') ||
      String(prev.tokkoPropertiesPath || '') !== String(next.tokkoPropertiesPath || '');

    if (next.tokkoEnabled && next.tokkoApiKey && (tokkoJustEnabled || tokkoCredentialsUpdated)) {
      tokkoKnowledgeSync = await syncTokkoLocationsToKnowledge(companyId);
    }
  } catch (e: any) {
    tokkoKnowledgeSync = { ok: false, error: String(e?.message || e || 'tokko_kb_sync_error') };
  }

  return res.json({ ok: true, settings: next, tokkoKnowledgeSync });
});

settingsRoutes.get('/meta/webhook-status', isAuth, async (req: any, res) => {
  const companyId = Number(req.user?.companyId || 0);
  const s = await getRuntimeSettingsForCompany(companyId);
  const callback = String(process.env.BACKEND_URL || 'https://login.charlott.ai') + '/api/ai/meta-leads/webhook';
  return res.json({
    verifyTokenConfigured: Boolean(String(s.metaLeadAdsWebhookVerifyToken || '').trim()),
    appIdConfigured: Boolean(String(s.metaLeadAdsAppId || '').trim()),
    appSecretConfigured: Boolean(String(s.metaLeadAdsAppSecret || '').trim()),
    pageIdConfigured: Boolean(String(s.metaLeadAdsPageId || '').trim()),
    callbackUrl: callback
  });
});

settingsRoutes.get('/integrations/api-key', isAuth, async (req: any, res) => {
  const companyId = Number(req.user?.companyId || 0);
  const company: any = await Company.findByPk(companyId);
  const apiKey = String(company?.integrationApiKey || '');
  return res.json({
    configured: Boolean(apiKey),
    apiKey,
    apiKeyMasked: apiKey ? maskKey(apiKey) : ''
  });
});

settingsRoutes.put('/integrations/api-key', isAuth, async (req: any, res) => {
  const companyId = Number(req.user?.companyId || 0);
  const apiKey = String(req.body?.apiKey || '').trim();
  const company: any = await Company.findByPk(companyId);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  await company.update({ integrationApiKey: apiKey || null } as any);
  return res.json({ ok: true, configured: Boolean(apiKey), apiKeyMasked: apiKey ? maskKey(apiKey) : '' });
});

export default settingsRoutes;
