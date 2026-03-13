#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE billing_plans SET features_json='[\"integrations_api\",\"meta_leads\"]' WHERE code='starter';"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE billing_plans SET features_json='[\"integrations_api\",\"meta_leads\",\"ai_rag\",\"advanced_reports\"]' WHERE code IN ('pro','scale');"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT code, features_json FROM billing_plans ORDER BY code;"
