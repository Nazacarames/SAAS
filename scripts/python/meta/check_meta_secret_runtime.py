import json
from pathlib import Path
p=Path('/home/deploy/atendechat/backend/runtime-settings.json')
d={}
if p.exists():
 d=json.loads(p.read_text() or '{}')
print('waCloudAppSecret_len',len(str(d.get('waCloudAppSecret',''))))
print('waWebhookAllowUnsigned',d.get('waWebhookAllowUnsigned'))

env=Path('/home/deploy/atendechat/backend/.env').read_text()
meta=[l for l in env.splitlines() if l.startswith('META_APP_SECRET=')]
print('META_APP_SECRET_len', len(meta[0].split('=',1)[1].strip()) if meta else 0)
