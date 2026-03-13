SELECT c.id, c.name, c.number, c."updatedAt", t.id AS ticket_id, t.status, t."lastMessage", t."updatedAt" AS ticket_updated
FROM contacts c
LEFT JOIN LATERAL (
  SELECT id, status, "lastMessage", "updatedAt"
  FROM tickets
  WHERE "contactId" = c.id
  ORDER BY id DESC
  LIMIT 1
) t ON true
WHERE c.id = 53;
