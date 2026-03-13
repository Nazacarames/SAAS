WITH target AS (
  SELECT t.id AS ticket_id,
         t."contactId" AS contact_id,
         t."lastMessage" AS body,
         ROW_NUMBER() OVER (ORDER BY t.id DESC) AS rn
  FROM tickets t
  LEFT JOIN messages m ON m."ticketId" = t.id
  WHERE t.status IN ('open','pending')
    AND COALESCE(t."lastMessage",'') ILIKE '¡Hola %'
  GROUP BY t.id, t."contactId", t."lastMessage"
  HAVING COUNT(m.id) = 0
)
INSERT INTO messages (id, body, ack, read, "fromMe", "mediaType", "ticketId", "contactId", "providerMessageId", "createdAt", "updatedAt")
SELECT
  ('meta-backfill-' || ticket_id || '-' || EXTRACT(EPOCH FROM NOW())::bigint || '-' || rn)::text AS id,
  body,
  1,
  true,
  true,
  'chat',
  ticket_id,
  contact_id,
  NULL,
  NOW(),
  NOW()
FROM target;
