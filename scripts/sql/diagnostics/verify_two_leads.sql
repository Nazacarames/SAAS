SELECT id, name, number, email, source, "createdAt" FROM contacts
WHERE regexp_replace(COALESCE(number,''), '\\D', '', 'g') IN ('541127713231','543413002429')
ORDER BY id DESC;

SELECT id, "contactId", status, "createdAt" FROM tickets
WHERE "contactId" IN (
  SELECT id FROM contacts WHERE regexp_replace(COALESCE(number,''), '\\D', '', 'g') IN ('541127713231','543413002429')
)
ORDER BY id DESC;
