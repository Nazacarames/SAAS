WITH toku AS (
  SELECT DISTINCT ct."contactId" AS contact_id
  FROM contact_tags ct
  JOIN tags t ON t.id = ct."tagId"
  WHERE t.name='enviado_tokko'
), inbound AS (
  SELECT DISTINCT m."contactId" AS contact_id
  FROM messages m
  WHERE m."fromMe" = false
)
SELECT
  (SELECT COUNT(*) FROM toku) AS enviados_tokko,
  (SELECT COUNT(*) FROM toku t JOIN inbound i ON i.contact_id=t.contact_id) AS con_entrante_en_algun_momento,
  (SELECT COUNT(*) FROM toku t LEFT JOIN inbound i ON i.contact_id=t.contact_id WHERE i.contact_id IS NULL) AS sin_entrante;
