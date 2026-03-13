#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
TOK=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1;")
for id in 1588415158941695 1309168171130018 1325236162745983 1211794260978866 932058132516261 1256515002505055; do
  echo "== $id =="
  curl -s "https://graph.facebook.com/v23.0/$id?fields=id,created_time,field_data,form_id&access_token=$TOK" | head -c 360; echo
  echo
 done
