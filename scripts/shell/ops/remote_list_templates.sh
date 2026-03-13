#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
row=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT COALESCE(waba_id,''), COALESCE(access_token,'') FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1;")
WABA=$(echo "$row" | cut -d'|' -f1)
TOK=$(echo "$row" | cut -d'|' -f2-)
curl -s "https://graph.facebook.com/v23.0/${WABA}/message_templates?fields=name,status,language,components&limit=200&access_token=${TOK}" > /tmp/meta_templates.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/meta_templates.json'))
if 'error' in j:
  print('ERR', j['error'])
else:
  for t in j.get('data',[]):
    name=t.get('name'); lang=t.get('language'); st=t.get('status')
    comps=t.get('components') or []
    body=[c for c in comps if c.get('type')=='BODY']
    txt=(body[0].get('text') if body else '') or ''
    print(f"{name}|{lang}|{st}|bodyvars={txt.count('{{')}")
PY
