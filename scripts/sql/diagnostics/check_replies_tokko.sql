WITH sent AS (
  SELECT m."contactId" AS contact_id, MIN(m."createdAt") AS first_sent_at
  FROM messages m
  WHERE m."fromMe" = true
  GROUP BY m."contactId"
), replied AS (
  SELECT m."contactId" AS contact_id, MIN(m."createdAt") AS first_reply_at
  FROM messages m
  JOIN sent s ON s.contact_id = m."contactId"
  WHERE m."fromMe" = false AND m."createdAt" > s.first_sent_at
  GROUP BY m."contactId"
), toku AS (
  SELECT ct."contactId" AS contact_id
  FROM contact_tags ct
  JOIN tags t ON t.id = ct."tagId"
  WHERE t.name='enviado_tokko'
)
SELECT
  (SELECT COUNT(*) FROM toku) AS enviados_tokko,
  (SELECT COUNT(*) FROM replied r JOIN toku t ON t.contact_id=r.contact_id) AS con_respuesta,
  (SELECT COUNT(*) FROM toku t LEFT JOIN replied r ON r.contact_id=t.contact_id WHERE r.contact_id IS NULL) AS sin_respuesta;

SELECT c.id, c.name, c.number,
       MAX(CASE WHEN m."fromMe"=true THEN m."createdAt" END) AS ultimo_saliente,
       MAX(CASE WHEN m."fromMe"=false THEN m."createdAt" END) AS ultimo_entrante
FROM contacts c
JOIN contact_tags ct ON ct."contactId"=c.id
JOIN tags t ON t.id=ct."tagId" AND t.name='enviado_tokko'
LEFT JOIN messages m ON m."contactId"=c.id
GROUP BY c.id,c.name,c.number
ORDER BY ultimo_entrante DESC NULLS LAST, ultimo_saliente DESC NULLS LAST
LIMIT 15;
