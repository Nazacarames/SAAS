#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
# Ensure integrations feature enabled with valid JSON array
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE company_billing SET plan_features='[\"integrations_api\",\"meta_leads\",\"advanced_reports\"]' WHERE company_id=1;"
