import json
import re
from pathlib import Path
from urllib.parse import urlencode

import psycopg2
import requests

rt_path = Path('/home/deploy/atendechat/backend/runtime-settings.json')
rt = json.loads(rt_path.read_text(encoding='utf-8')) if rt_path.exists() else {}

if not rt.get('tokkoEnabled'):
    raise SystemExit('ERROR: tokkoEnabled=false')

api_key = str(rt.get('tokkoApiKey') or '').strip()
base = str(rt.get('tokkoBaseUrl') or 'https://www.tokkobroker.com/api/v1').rstrip('/')
leads_path = str(rt.get('tokkoLeadsPath') or '/webcontact/')
if not leads_path.startswith('/'):
    leads_path = '/' + leads_path
if not api_key:
    raise SystemExit('ERROR: missing tokkoApiKey')

url = f"{base}{leads_path}?" + urlencode({'key': api_key})

env = {}
for line in Path('/home/deploy/atendechat/backend/.env').read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.strip().startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()

conn = psycopg2.connect(
    host=env.get('DB_HOST', '127.0.0.1'),
    port=int(env.get('DB_PORT', '5432')),
    user=env.get('DB_USER'),
    password=env.get('DB_PASS'),
    dbname=env.get('DB_NAME')
)
conn.autocommit = True
cur = conn.cursor()

cur.execute(
    '''
    INSERT INTO tags (name, color, "createdAt", "updatedAt")
    VALUES ('enviado_tokko', '#0EA5E9', NOW(), NOW())
    ON CONFLICT (name) DO NOTHING
    '''
)
cur.execute("SELECT id FROM tags WHERE name='enviado_tokko' LIMIT 1")
tag_id = cur.fetchone()[0]

cur.execute(
    '''
    SELECT c.id, COALESCE(c.name,''), COALESCE(c.number,''), COALESCE(c.email,''), COALESCE(c.source,'')
    FROM contacts c
    WHERE c."companyId" = 1
      AND COALESCE(c.isGroup, false) = false
      AND COALESCE(regexp_replace(c.number, '\\D', '', 'g'),'') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct."contactId" = c.id AND ct."tagId" = %s
      )
    ORDER BY c.id ASC
    ''',
    (tag_id,)
)
rows = cur.fetchall()

ok = 0
fail = 0
skipped = 0

for cid, name, number, email, source in rows:
    phone = re.sub(r'\D', '', number or '')
    if not phone:
        skipped += 1
        continue

    payload = {
        'name': (name or phone)[:120],
        'email': (email or '')[:180],
        'phone': phone,
        'text': 'Backfill automático desde Charlott CRM',
        'source': source or 'backfill-existing-leads',
        'tags': ['Lead_Calificado', 'Bot']
    }

    try:
        r = requests.post(url, json=payload, timeout=20)
        if 200 <= r.status_code < 300:
            ok += 1
            cur.execute(
                '''
                INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
                VALUES (%s, %s, NOW(), NOW())
                ON CONFLICT DO NOTHING
                ''',
                (cid, tag_id)
            )
        else:
            fail += 1
    except Exception:
        fail += 1

print(json.dumps({
    'candidates': len(rows),
    'sent_ok': ok,
    'failed': fail,
    'skipped': skipped,
    'tag_id': tag_id,
    'endpoint': f"{base}{leads_path}"
}, ensure_ascii=False))

cur.close()
conn.close()
