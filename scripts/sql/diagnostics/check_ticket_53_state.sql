SELECT t.id, t.status, t."queueId", t."userId", t."lastMessage", t."updatedAt"
FROM tickets t
WHERE t."contactId"=53
ORDER BY t.id DESC
LIMIT 3;
