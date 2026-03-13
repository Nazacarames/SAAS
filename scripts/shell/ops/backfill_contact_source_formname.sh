#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
WITH latest_meta AS (
  SELECT DISTINCT ON (ev.company_id, norm.phone, norm.email)
    ev.company_id,
    norm.phone,
    norm.email,
    COALESCE(NULLIF(ev.form_name,''), CASE WHEN COALESCE(ev.form_id,'')<>'' THEN 'Formulario '||ev.form_id ELSE 'Meta Lead Ads' END) AS source_label,
    ev.created_at
  FROM meta_lead_events ev
  CROSS JOIN LATERAL (
    SELECT
      NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''), '\D', '', 'g'), '') AS phone,
      NULLIF(LOWER(COALESCE(ev.contact_email,'')), '') AS email
  ) norm
  WHERE ev.company_id IS NOT NULL
  ORDER BY ev.company_id, norm.phone, norm.email, ev.created_at DESC
)
UPDATE contacts c
SET source = lm.source_label,
    "updatedAt" = NOW()
FROM latest_meta lm
WHERE c."companyId" = lm.company_id
  AND (
    (lm.phone IS NOT NULL AND NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g'), '') = lm.phone)
    OR (lm.email IS NOT NULL AND NULLIF(LOWER(COALESCE(c.email,'')), '') = lm.email)
  )
  AND (
    COALESCE(c.source,'') = ''
    OR c.source ~* '^meta_form_'
    OR c.source ~* '^Formulario\s+[0-9]+'
    OR c.source = 'meta-lead-webhook'
    OR c.source = 'meta_lead_ads'
  );
SQL
