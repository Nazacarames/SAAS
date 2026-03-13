UPDATE messages m
SET body = CONCAT('Hola ', split_part(COALESCE(c.name,'Hola'), ' ', 1), ' 👋 Gracias por escribirnos. ¿Querés que te ayude con precios, ubicación o coordinar una visita?')
FROM contacts c
WHERE m."contactId" = c.id
  AND m."fromMe" = true
  AND m.body = 'Template hola enviado';

UPDATE tickets t
SET "lastMessage" = CONCAT('Hola ', split_part(COALESCE(c.name,'Hola'), ' ', 1), ' 👋 Gracias por escribirnos. ¿Querés que te ayude con precios, ubicación o coordinar una visita?')
FROM contacts c
WHERE t."contactId" = c.id
  AND t."lastMessage" = 'Template hola enviado';
