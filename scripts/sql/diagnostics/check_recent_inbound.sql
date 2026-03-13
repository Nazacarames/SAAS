SELECT c.id, c.name, c.number, MAX(m."createdAt") AS ultimo_entrante,
       BOOL_OR(t.name='enviado_tokko') AS enviado_tokko
FROM contacts c
JOIN messages m ON m."contactId"=c.id AND m."fromMe"=false
LEFT JOIN contact_tags ct ON ct."contactId"=c.id
LEFT JOIN tags t ON t.id=ct."tagId"
GROUP BY c.id,c.name,c.number
ORDER BY ultimo_entrante DESC
LIMIT 20;
