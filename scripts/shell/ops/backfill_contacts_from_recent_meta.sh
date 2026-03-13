#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
WITH recent AS (
  SELECT company_id,
         NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\D', '', 'g'), '') AS phone,
         NULLIF(LOWER(COALESCE(contact_email,'')), '') AS email,
         NULLIF(COALESCE(contact_name,''), '') AS name,
         COALESCE(NULLIF(form_name,''), CASE WHEN COALESCE(form_id,'')<>'' THEN 'Formulario '||form_id ELSE 'Meta Lead Ads' END) AS source_label,
         MAX(created_at) AS last_seen
  FROM meta_lead_events
  WHERE id >= 37
  GROUP BY company_id, NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\D', '', 'g'), ''), NULLIF(LOWER(COALESCE(contact_email,'')), ''), NULLIF(COALESCE(contact_name,''), ''), COALESCE(NULLIF(form_name,''), CASE WHEN COALESCE(form_id,'')<>'' THEN 'Formulario '||form_id ELSE 'Meta Lead Ads' END)
), upserted AS (
  INSERT INTO contacts (name, number, email, source, "leadStatus", "isGroup", "companyId", "createdAt", "updatedAt")
  SELECT COALESCE(name, phone, email, 'Lead Meta'), COALESCE(phone,''), COALESCE(email,''), source_label, 'nuevo_ingreso', false, company_id, NOW(), NOW()
  FROM recent r
  WHERE (phone IS NOT NULL OR email IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM contacts c
      WHERE c."companyId" = r.company_id
        AND ((r.phone IS NOT NULL AND NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g'), '') = r.phone)
          OR (r.email IS NOT NULL AND NULLIF(LOWER(COALESCE(c.email,'')), '') = r.email))
    )
  RETURNING id, "companyId", number, email
), contact_match AS (
  SELECT c.id AS contact_id, c."companyId" AS company_id
  FROM contacts c
  JOIN recent r ON r.company_id = c."companyId"
   AND ((r.phone IS NOT NULL AND NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g'), '') = r.phone)
     OR (r.email IS NOT NULL AND NULLIF(LOWER(COALESCE(c.email,'')), '') = r.email))
), w AS (
  SELECT "companyId" AS company_id, MIN(id) AS whatsapp_id FROM whatsapps GROUP BY "companyId"
)
INSERT INTO tickets ("contactId", "whatsappId", "companyId", status, "unreadMessages", "lastMessage", "createdAt", "updatedAt")
SELECT cm.contact_id, w.whatsapp_id, cm.company_id, 'pending', 0, 'Nuevo lead Meta Ads', NOW(), NOW()
FROM contact_match cm
JOIN w ON w.company_id = cm.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM tickets t WHERE t."contactId" = cm.contact_id AND t."companyId" = cm.company_id AND t.status IN ('open','pending')
);
SQL
