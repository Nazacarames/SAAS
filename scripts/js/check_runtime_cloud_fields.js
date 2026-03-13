const s=require('/home/deploy/atendechat/backend/runtime-settings.json');
console.log(JSON.stringify({
 waCloudAccessTokenLen:String(s.waCloudAccessToken||'').length,
 waCloudPhoneNumberId:s.waCloudPhoneNumberId||'',
 waCloudAppSecretLen:String(s.waCloudAppSecret||'').length,
 waWebhookAllowUnsigned:s.waWebhookAllowUnsigned
},null,2));
