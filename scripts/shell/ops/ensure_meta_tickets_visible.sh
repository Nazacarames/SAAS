#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
WITH meta_contacts AS (
  SELECT DISTINCT
    ev.company_id,
    NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''), '\D', '', 'g'), '') AS phone,
    NULLIF(LOWER(COALESCE(ev.contact_email,'')), '') AS email
  FROM meta_lead_events ev
  WHERE ev.created_at >= NOW() - INTERVAL '14 days'
    AND COALESCE(ev.leadgen_id,'') <> ''
), matched AS (
  SELECT DISTINCT c.id AS contact_id, c."companyId" AS company_id
  FROM contacts c
  JOIN meta_contacts m ON m.company_id = c."companyId"
   AND ((m.phone IS NOT NULL AND NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g'), '') = m.phone)
     OR (m.email IS NOT NULL AND NULLIF(LOWER(COALESCE(c.email,'')), '') = m.email))
), w AS (
  SELECT "companyId" AS company_id, MIN(id) AS whatsapp_id
  FROM whatsapps
  GROUP BY "companyId"
), inserted AS (
  INSERT INTO tickets ("contactId", "whatsappId", "companyId", status, "unreadMessages", "lastMessage", "createdAt", "updatedAt")
  SELECT m.contact_id, w.whatsapp_id, m.company_id, 'open', 0, '[TEMPLATE:hola] apertura automática Meta Lead', NOW(), NOW()
  FROM matched m
  JOIN w ON w.company_id = m.company_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tickets t
    WHERE t."contactId" = m.contact_id
      AND t."companyId" = m.company_id
      AND t.status IN ('open','pending')
  )
  RETURNING id, "contactId"
)
SELECT COUNT(*) AS tickets_created FROM inserted;

UPDATE tickets t
SET status = 'open',
    "updatedAt" = NOW(),
    "lastMessage" = CASE WHEN COALESCE(t."lastMessage",'') = '' THEN '[TEMPLATE:hola] apertura automática Meta Lead' ELSE t."lastMessage" END
FROM contacts c
WHERE t."contactId" = c.id
  AND t."companyId" = c."companyId"
  AND c.source IS NOT NULL
  AND c.source <> ''
  AND c."updatedAt" >= NOW() - INTERVAL '14 days'
  AND t.status IN ('open','pending');
SQL
