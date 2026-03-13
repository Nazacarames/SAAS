SELECT id, "ticketId", "contactId", "fromMe", left(body,120) AS body, "createdAt"
FROM messages
WHERE "contactId"=49
ORDER BY "createdAt" DESC
LIMIT 10;
