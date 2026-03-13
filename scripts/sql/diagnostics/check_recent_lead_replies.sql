SELECT
  t.id AS ticket_id,
  c.name,
  c.number,
  m.body,
  m."createdAt"
FROM messages m
JOIN tickets t ON t.id = m."ticketId"
JOIN contacts c ON c.id = t."contactId"
WHERE m."fromMe" = false
  AND m."createdAt" >= NOW() - INTERVAL '24 hours'
  AND c.source IS NOT NULL
  AND c.source <> ''
ORDER BY m."createdAt" DESC
LIMIT 80;
