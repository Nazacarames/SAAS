SELECT m.id, m."contactId", m."fromMe", m.body, m."createdAt"
FROM messages m
ORDER BY m."createdAt" DESC
LIMIT 20;
