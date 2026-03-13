import json
from pathlib import Path
TOKEN = "EAAUDWedCKIkBQZC8PzT59ZAHZCKwGivEwKAZAvD8zJg6L6GLA0ITtDuHw2yAhArVaJlDKiVTZBstg3lq545lQrObuu04jTaK2Njth62iBo23jILQe5iLznlGdAfTjgOJguMx89wUEeOIGnFXbKRQ45wujdgiwGRCW8yG2ZAFXPAg1krJrMWnFt9niT5CxjDe7MrgZDZD"
PHONE_NUMBER_ID = "993878790464505"
rp=Path('/home/deploy/atendechat/backend/runtime-settings.json')
d={}
if rp.exists():
  try:d=json.loads(rp.read_text() or '{}')
  except:d={}
d['waCloudAccessToken']=TOKEN
d['waCloudPhoneNumberId']=PHONE_NUMBER_ID
d.setdefault('waWebhookAllowUnsigned', True)
rp.write_text(json.dumps(d,indent=2))
print('runtime token updated')
