#!/usr/bin/env bash
set -euo pipefail
TOKEN='EAAUDWedCKIkBQZC8PzT59ZAHZCKwGivEwKAZAvD8zJg6L6GLA0ITtDuHw2yAhArVaJlDKiVTZBstg3lq545lQrObuu04jTaK2Njth62iBo23jILQe5iLznlGdAfTjgOJguMx89wUEeOIGnFXbKRQ45wujdgiwGRCW8yG2ZAFXPAg1krJrMWnFt9niT5CxjDe7MrgZDZD'
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE meta_connections SET access_token='${TOKEN}', phone_number_id='993878790464505', updated_at=NOW() WHERE id=(SELECT id FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1);"
