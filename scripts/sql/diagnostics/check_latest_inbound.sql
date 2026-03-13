SELECT id, "contactId", body, "createdAt"
FROM messages
WHERE "fromMe" = false
ORDER BY "createdAt" DESC
LIMIT 5;
