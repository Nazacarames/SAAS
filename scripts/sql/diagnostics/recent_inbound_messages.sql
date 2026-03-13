SELECT m.id, m."ticketId", m."contactId", left(m.body,120) AS body, m."createdAt", c.name, c.number
FROM messages m
LEFT JOIN contacts c ON c.id = m."contactId"
WHERE m."createdAt" >= NOW() - INTERVAL '60 minutes'
  AND m."fromMe" = false
ORDER BY m."createdAt" DESC
LIMIT 60;
