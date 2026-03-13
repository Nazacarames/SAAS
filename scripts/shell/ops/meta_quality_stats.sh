#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT COUNT(*) AS total, SUM(CASE WHEN coalesce(leadgen_id,'')<>'' THEN 1 ELSE 0 END) AS with_leadgen, SUM(CASE WHEN coalesce(leadgen_id,'')<>'' AND coalesce(contact_name,'')='' AND coalesce(contact_email,'')='' AND REGEXP_REPLACE(coalesce(contact_phone,''),'\\D','','g')='' THEN 1 ELSE 0 END) AS leadgen_but_empty FROM meta_lead_events;"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT id, leadgen_id, created_at FROM meta_lead_events WHERE coalesce(leadgen_id,'')<>'' AND coalesce(contact_name,'')='' AND coalesce(contact_email,'')='' AND REGEXP_REPLACE(coalesce(contact_phone,''),'\\D','','g')='' ORDER BY id DESC LIMIT 20;"