const { getRuntimeSettings } = require('./dist/services/SettingsServices/RuntimeSettingsService');
const s = getRuntimeSettings();
console.log(JSON.stringify({ waWebhookAllowUnsigned: s.waWebhookAllowUnsigned, waCloudAppSecretLen: String(s.waCloudAppSecret||'').length }, null, 2));
