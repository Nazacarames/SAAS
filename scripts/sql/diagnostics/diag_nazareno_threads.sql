SELECT id, name, number, source, "createdAt", "updatedAt"
FROM contacts
WHERE regexp_replace(COALESCE(number,''), '\\D', '', 'g') LIKE '%1127713231'
ORDER BY id;

SELECT m.id, m."contactId", c.number, m."fromMe", m.body, m."providerMessageId", m."createdAt"
FROM messages m
JOIN contacts c ON c.id = m."contactId"
WHERE regexp_replace(COALESCE(c.number,''), '\\D', '', 'g') LIKE '%1127713231'
ORDER BY m."createdAt" DESC
LIMIT 50;
