#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
psql_cmd(){ PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "$1"; }

echo '--- recent meta_lead_events ---'
psql_cmd "SELECT id, company_id, event_id, leadgen_id, page_id, form_id, left(coalesce(contact_name,''),40), left(coalesce(contact_email,''),40), left(coalesce(contact_phone,''),25), created_at FROM meta_lead_events ORDER BY id DESC LIMIT 12;"

echo '--- empties stats last 7d ---'
psql_cmd "SELECT COUNT(*) total, SUM(CASE WHEN coalesce(contact_name,'')='' THEN 1 ELSE 0 END) no_name, SUM(CASE WHEN coalesce(contact_email,'')='' THEN 1 ELSE 0 END) no_email, SUM(CASE WHEN REGEXP_REPLACE(coalesce(contact_phone,''),'\\D','','g')='' THEN 1 ELSE 0 END) no_phone FROM meta_lead_events WHERE created_at >= NOW() - INTERVAL '7 days';"

echo '--- sample form_fields_json ---'
psql_cmd "SELECT id, left(coalesce(form_fields_json,''),220) FROM meta_lead_events ORDER BY id DESC LIMIT 5;"

echo '--- meta_connections token presence ---'
psql_cmd "SELECT id, company_id, CASE WHEN coalesce(access_token,'')='' THEN 'empty' ELSE 'present' END token_state, created_at, updated_at FROM meta_connections ORDER BY id DESC LIMIT 5;"
