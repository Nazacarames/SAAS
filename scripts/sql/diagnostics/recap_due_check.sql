SELECT COUNT(*) AS due_contacts
FROM contacts c
WHERE COALESCE(c."isGroup", false)=false
  AND COALESCE(c."leadStatus",'') NOT IN ('read','closed','won','lost')
  AND EXISTS (
    SELECT 1 FROM tickets t
    WHERE t."contactId"=c.id AND t.status IN ('open','pending')
  )
  AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m."contactId"=c.id AND m."fromMe"=false
  )
  AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m."contactId"=c.id AND m."fromMe"=true
  )
  AND COALESCE(c."lastInteractionAt", c."updatedAt", c."createdAt") < NOW() - INTERVAL '3 days';
