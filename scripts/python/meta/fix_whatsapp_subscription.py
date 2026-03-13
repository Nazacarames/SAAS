import json, requests
from pathlib import Path

settings_path=Path('/home/deploy/atendechat/backend/runtime-settings.json')
settings=json.loads(settings_path.read_text() or '{}') if settings_path.exists() else {}
app_id=str(settings.get('metaLeadAdsAppId','')).strip()
app_secret=str(settings.get('metaLeadAdsAppSecret','')).strip()
verify=str(settings.get('waCloudVerifyToken','')).strip()

if app_secret and not str(settings.get('waCloudAppSecret','')).strip():
    settings['waCloudAppSecret']=app_secret
    settings_path.write_text(json.dumps(settings,indent=2))
    print('waCloudAppSecret hydrated from metaLeadAdsAppSecret')

if not (app_id and app_secret and verify):
    print('missing data', {'app_id':bool(app_id),'app_secret':bool(app_secret),'verify':bool(verify)})
    raise SystemExit(1)

app_token=f"{app_id}|{app_secret}"
callback='https://login.charlott.ai/api/whatsapp-cloud/webhook'
fields='messages,message_template_status_update,message_reactions,messaging_postbacks'

# upsert app subscription for whatsapp object
r=requests.post(f'https://graph.facebook.com/v23.0/{app_id}/subscriptions',data={
    'object':'whatsapp_business_account',
    'callback_url':callback,
    'verify_token':verify,
    'fields':fields,
    'include_values':'true',
    'access_token':app_token
},timeout=30)
print('post_subscriptions',r.status_code,r.text[:800])

r2=requests.get(f'https://graph.facebook.com/v23.0/{app_id}/subscriptions',params={'access_token':app_token},timeout=30)
print('get_subscriptions',r2.status_code,r2.text[:1200])
