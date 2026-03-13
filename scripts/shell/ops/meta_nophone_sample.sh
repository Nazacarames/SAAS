#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT id, leadgen_id, form_id, left(coalesce(form_fields_json,''),180), left(coalesce(payload_json,''),180), created_at FROM meta_lead_events WHERE NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL ORDER BY id DESC LIMIT 15;"