import json
from pathlib import Path
import psycopg2

TOKEN = "EAAUDWedCKIkBQZC8PzT59ZAHZCKwGivEwKAZAvD8zJg6L6GLA0ITtDuHw2yAhArVaJlDKiVTZBstg3lq545lQrObuu04jTaK2Njth62iBo23jILQe5iLznlGdAfTjgOJguMx89wUEeOIGnFXbKRQ45wujdgiwGRCW8yG2ZAFXPAg1krJrMWnFt9niT5CxjDe7MrgZDZD"
PHONE_NUMBER_ID = "993878790464505"

# runtime settings
rp = Path('/home/deploy/atendechat/backend/runtime-settings.json')
settings = {}
if rp.exists():
    try:
        settings = json.loads(rp.read_text() or '{}')
    except Exception:
        settings = {}

settings['waCloudAccessToken'] = TOKEN
settings['waCloudPhoneNumberId'] = PHONE_NUMBER_ID
settings.setdefault('waWebhookAllowUnsigned', True)
rp.write_text(json.dumps(settings, indent=2))
print('runtime-settings updated')

# db meta_connections
env = {}
for line in Path('/home/deploy/atendechat/backend/.env').read_text().splitlines():
    if '=' in line and not line.strip().startswith('#'):
        k,v = line.split('=',1)
        env[k.strip()] = v.strip()

conn = psycopg2.connect(
    host=env.get('DB_HOST','127.0.0.1'),
    port=int(env.get('DB_PORT','5432')),
    user=env.get('DB_USER'),
    password=env.get('DB_PASS'),
    dbname=env.get('DB_NAME')
)
conn.autocommit = True
cur = conn.cursor()
cur.execute('''
    UPDATE meta_connections
    SET access_token=%s,
        phone_number_id=%s,
        updated_at=NOW()
    WHERE id = (SELECT id FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1)
''', (TOKEN, PHONE_NUMBER_ID))
print('meta_connections updated rows=', cur.rowcount)
cur.close(); conn.close()
