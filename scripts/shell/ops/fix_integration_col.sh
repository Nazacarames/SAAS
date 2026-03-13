#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
SQL="SELECT column_name FROM information_schema.columns WHERE table_name='companies' AND column_name IN ('integrationApiKey','integrationapikey');"
cols=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "$SQL")
echo "found_cols: $cols"
if echo "$cols" | grep -q '^integrationapikey$' && ! echo "$cols" | grep -q '^integrationApiKey$'; then
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c 'ALTER TABLE companies RENAME COLUMN integrationapikey TO "integrationApiKey";'
  echo "renamed integrationapikey -> integrationApiKey"
elif ! echo "$cols" | grep -q '^integrationApiKey$'; then
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c 'ALTER TABLE companies ADD COLUMN "integrationApiKey" VARCHAR(255);'
  echo "added integrationApiKey"
else
  echo "integrationApiKey already present"
fi
