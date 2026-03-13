#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
psqlq(){ PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "$1"; }
echo '== totals =='
psqlq "SELECT COUNT(*) total, SUM(CASE WHEN NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL THEN 1 ELSE 0 END) no_phone, SUM(CASE WHEN COALESCE(contact_name,'')='' THEN 1 ELSE 0 END) no_name, SUM(CASE WHEN COALESCE(contact_email,'')='' THEN 1 ELSE 0 END) no_email FROM meta_lead_events;"
echo '== last 15 missing-phone events =='
psqlq "SELECT id, leadgen_id, form_id, left(coalesce(form_name,''),40), left(coalesce(form_fields_json,''),180), created_at FROM meta_lead_events WHERE NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL ORDER BY id DESC LIMIT 15;"
echo '== leads with field_data but empty phone =='
psqlq "SELECT id, leadgen_id, created_at FROM meta_lead_events WHERE NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL AND COALESCE(form_fields_json,'') NOT IN ('','{}') ORDER BY id DESC LIMIT 20;"
