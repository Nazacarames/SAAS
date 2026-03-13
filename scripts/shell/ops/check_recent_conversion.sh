#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "WITH ev AS (SELECT DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') AS phone, NULLIF(LOWER(COALESCE(contact_email,'')), '') AS email FROM meta_lead_events WHERE id>=37) SELECT COUNT(*) FROM ev WHERE (phone IS NOT NULL OR email IS NOT NULL);"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "WITH ev AS (SELECT DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') AS phone, NULLIF(LOWER(COALESCE(contact_email,'')), '') AS email FROM meta_lead_events WHERE id>=37), m AS (SELECT ev.phone, ev.email, EXISTS(SELECT 1 FROM contacts c WHERE (ev.phone IS NOT NULL AND NULLIF(REGEXP_REPLACE(COALESCE(c.number,''),'\\D','','g'),'')=ev.phone) OR (ev.email IS NOT NULL AND NULLIF(LOWER(COALESCE(c.email,'')),'')=ev.email)) AS has_contact FROM ev) SELECT SUM(CASE WHEN has_contact THEN 1 ELSE 0 END), SUM(CASE WHEN NOT has_contact THEN 1 ELSE 0 END) FROM m;"