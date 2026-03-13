SELECT c.id, c.name, c.number,
       MAX(CASE WHEN m."fromMe"=true THEN m."createdAt" END) AS last_out,
       MAX(CASE WHEN m."fromMe"=false THEN m."createdAt" END) AS last_in,
       COUNT(*) FILTER (WHERE m."fromMe"=false) AS in_count,
       COUNT(*) FILTER (WHERE m."fromMe"=true) AS out_count
FROM contacts c
LEFT JOIN messages m ON m."contactId"=c.id
WHERE c.id IN (51,52)
GROUP BY c.id,c.name,c.number
ORDER BY c.id;

SELECT id, "contactId", "fromMe", body, "providerMessageId", "createdAt"
FROM messages
WHERE "contactId" IN (51,52)
ORDER BY "createdAt" DESC
LIMIT 20;
