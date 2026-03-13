import json
from pathlib import Path

rp=Path('/home/deploy/atendechat/backend/runtime-settings.json')
d=json.loads(rp.read_text() or '{}') if rp.exists() else {}
print('waCloudAppSecret',len(str(d.get('waCloudAppSecret',''))))
print('waCloudAccessToken',len(str(d.get('waCloudAccessToken',''))))
print('metaLeadAdsAppSecret',len(str(d.get('metaLeadAdsAppSecret',''))))

env=Path('/home/deploy/atendechat/backend/.env').read_text() if Path('/home/deploy/atendechat/backend/.env').exists() else ''
for k in ['WA_CLOUD_ACCESS_TOKEN','WA_CLOUD_PHONE_NUMBER_ID','META_APP_ID','META_APP_SECRET']:
    v=''
    for line in env.splitlines():
        if line.startswith(k+'='):
            v=line.split('=',1)[1].strip(); break
    print(k,len(v))
