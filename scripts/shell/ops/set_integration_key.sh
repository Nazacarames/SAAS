#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE companies SET \"integrationApiKey\"='mA1thx8RrE-iU5xu0gOkB2x6weSMyqsY' WHERE id=1;"
