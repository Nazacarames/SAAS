SELECT NOW() as now_utc;

SELECT id, "ticketId", "contactId", "fromMe", body, "createdAt"
FROM messages
WHERE "createdAt" >= NOW() - INTERVAL '30 minutes'
  AND (
    "contactId" = 49
    OR body ILIKE '%test crm%'
  )
ORDER BY "createdAt" DESC;

SELECT t.id, t."contactId", t.status, t."lastMessage", t."updatedAt"
FROM tickets t
WHERE t.id = 47;

SELECT c.id, c.name, c.number, c.email, c."updatedAt"
FROM contacts c
WHERE c.id = 49;
