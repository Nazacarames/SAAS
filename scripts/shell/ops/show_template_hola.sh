#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
row=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT COALESCE(waba_id,''), COALESCE(access_token,'') FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1;")
WABA=$(echo "$row" | cut -d'|' -f1)
TOK=$(echo "$row" | cut -d'|' -f2-)
curl -s "https://graph.facebook.com/v23.0/${WABA}/message_templates?fields=name,status,language,components&limit=200&access_token=${TOK}" | python3 - <<'PY'
import sys,json
j=json.load(sys.stdin)
for t in j.get('data',[]):
  if t.get('name')=='hola':
    print(json.dumps(t,indent=2,ensure_ascii=False))
PY
