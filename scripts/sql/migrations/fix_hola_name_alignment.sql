WITH canon AS (
  SELECT
    t.id AS ticket_id,
    c.id AS contact_id,
    ('¡Hola ' || COALESCE(NULLIF(split_part(c.name, ' ', 1), ''), 'amigo') || '! Gracias por tu interés en Skygarden. Recibimos tu solicitud desde el formulario y ya estamos preparando la información que pediste.')::text AS expected_body
  FROM tickets t
  JOIN contacts c ON c.id = t."contactId"
  WHERE t.status IN ('open','pending')
    AND c."updatedAt" >= NOW() - INTERVAL '21 days'
), upd_ticket AS (
  UPDATE tickets t
  SET "lastMessage" = canon.expected_body,
      "updatedAt" = NOW()
  FROM canon
  WHERE t.id = canon.ticket_id
    AND (
      COALESCE(t."lastMessage",'') ILIKE '¡Hola %'
      OR COALESCE(t."lastMessage",'') ILIKE '[TEMPLATE:hola]%'
    )
  RETURNING t.id
)
UPDATE messages m
SET body = canon.expected_body,
    "updatedAt" = NOW()
FROM canon
WHERE m."ticketId" = canon.ticket_id
  AND m."contactId" = canon.contact_id
  AND m."fromMe" = true
  AND COALESCE(m.body,'') ILIKE '¡Hola %';
