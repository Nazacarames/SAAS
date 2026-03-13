#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT id, leadgen_id, left(form_fields_json,180), left(payload_json,220) FROM meta_lead_events WHERE id IN (21,19,18,16,14,36) ORDER BY id;"