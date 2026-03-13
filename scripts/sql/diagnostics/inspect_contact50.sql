SELECT id, "contactId", "ticketId", "fromMe", body, "createdAt"
FROM messages
WHERE "contactId" = 50
ORDER BY "createdAt" ASC;
