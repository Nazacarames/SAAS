#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT id, company_id, left(access_token,25), length(access_token), updated_at FROM meta_connections ORDER BY id DESC LIMIT 3;"
LEAD_ID="1588415158941695"
APP_TOKEN="${META_APP_ID:-}|${META_APP_SECRET:-}"
echo "-- app token test --"
curl -s "https://graph.facebook.com/v23.0/${LEAD_ID}?fields=id,created_time,field_data,form_id&access_token=${APP_TOKEN}" | head -c 500; echo

TOK=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1;")
echo "-- latest connection token test --"
curl -s "https://graph.facebook.com/v23.0/${LEAD_ID}?fields=id,created_time,field_data,form_id&access_token=${TOK}" | head -c 500; echo
