import json
from pathlib import Path
import psycopg2

env = {}
for l in Path('/home/deploy/atendechat/backend/.env').read_text(encoding='utf-8').splitlines():
    if '=' in l and not l.strip().startswith('#'):
        k, v = l.split('=', 1)
        env[k.strip()] = v.strip()

conn = psycopg2.connect(
    host=env.get('DB_HOST'),
    port=env.get('DB_PORT', '5432'),
    user=env.get('DB_USER'),
    password=env.get('DB_PASS'),
    dbname=env.get('DB_NAME')
)
cur = conn.cursor()
cur.execute("SELECT access_token, phone_number_id FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1")
row = cur.fetchone()
cur.close()
conn.close()

if not row:
    raise SystemExit('no meta_connections row')

access, phone = row
p = Path('/home/deploy/atendechat/backend/runtime-settings.json')
d = json.loads(p.read_text(encoding='utf-8'))
d['waCloudAccessToken'] = access or ''
d['waCloudPhoneNumberId'] = str(phone or '')
p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8')
print('synced', len(str(access or '')), str(phone or ''))
