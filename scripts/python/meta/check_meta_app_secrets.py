import json
from pathlib import Path
p=Path('/home/deploy/atendechat/backend/runtime-settings.json')
d=json.loads(p.read_text() or '{}') if p.exists() else {}
for k in ['metaLeadAdsAppSecret','metaLeadAdsAppId','waCloudAppSecret','waCloudVerifyToken']:
 v=str(d.get(k,''))
 print(k,'len',len(v), 'prefix',v[:6])
