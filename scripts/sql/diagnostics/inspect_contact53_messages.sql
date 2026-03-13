SELECT id, "fromMe", body, "providerMessageId", "ticketId", "createdAt"
FROM messages
WHERE "contactId" = 53
ORDER BY "createdAt" ASC;
