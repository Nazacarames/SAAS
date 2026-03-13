import json
from pathlib import Path
p=Path('/home/deploy/atendechat/backend/runtime-settings.json')
d={}
if p.exists():
  try:d=json.loads(p.read_text() or '{}')
  except:d={}
d['waWebhookAllowUnsigned']=True
p.write_text(json.dumps(d,indent=2))
print('saved waWebhookAllowUnsigned=true')
