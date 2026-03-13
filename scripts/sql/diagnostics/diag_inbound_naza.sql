SELECT m.id, m."ticketId", m."contactId", m."fromMe", left(m.body,120) AS body, m."createdAt"
FROM messages m
WHERE m."createdAt" >= NOW() - INTERVAL '2 hours'
ORDER BY m."createdAt" DESC
LIMIT 80;

SELECT c.id, c.name, c.number, c.email, c."updatedAt"
FROM contacts c
WHERE REGEXP_REPLACE(COALESCE(c.number,''), '\D','','g') LIKE '%1127713231%'
   OR LOWER(COALESCE(c.email,''))='nachicarames@gmail.com'
ORDER BY c."updatedAt" DESC;

SELECT t.id, t."contactId", t.status, t."lastMessage", t."updatedAt"
FROM tickets t
JOIN contacts c ON c.id=t."contactId"
WHERE REGEXP_REPLACE(COALESCE(c.number,''), '\D','','g') LIKE '%1127713231%'
ORDER BY t."updatedAt" DESC;
