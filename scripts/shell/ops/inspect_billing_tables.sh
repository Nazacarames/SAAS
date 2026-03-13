#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%billing%' ORDER BY 1;"
