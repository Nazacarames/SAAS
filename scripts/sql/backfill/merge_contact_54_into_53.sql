BEGIN;

-- Move child records
UPDATE tickets SET "contactId" = 53, "updatedAt" = NOW() WHERE "contactId" = 54;
UPDATE messages SET "contactId" = 53, "updatedAt" = NOW() WHERE "contactId" = 54;
UPDATE contact_tags SET "contactId" = 53, "updatedAt" = NOW() WHERE "contactId" = 54;

-- Deduplicate tag links
DELETE FROM contact_tags a
USING contact_tags b
WHERE a.ctid < b.ctid
  AND a."contactId" = b."contactId"
  AND a."tagId" = b."tagId"
  AND a."contactId" = 53;

-- Keep richer profile on primary
UPDATE contacts c
SET name = CASE WHEN COALESCE(c.name,'') = '' OR c.name ~ '^549[0-9]+' THEN (SELECT name FROM contacts WHERE id = 54) ELSE c.name END,
    email = CASE WHEN COALESCE(c.email,'') = '' THEN (SELECT email FROM contacts WHERE id = 54) ELSE c.email END,
    source = CASE WHEN COALESCE(c.source,'') = '' THEN (SELECT source FROM contacts WHERE id = 54) ELSE c.source END,
    "updatedAt" = NOW()
WHERE c.id = 53;

DELETE FROM contacts WHERE id = 54;

COMMIT;
