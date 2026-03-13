UPDATE messages
SET body = 'Template hola enviado'
WHERE "fromMe" = true
  AND (
    body ILIKE 'Hola %Gracias por escribirnos%'
    OR body ILIKE '¡Hola %Gracias por tu interés%'
  );

UPDATE tickets t
SET "lastMessage" = 'Template hola enviado'
WHERE (
    t."lastMessage" ILIKE 'Hola %Gracias por escribirnos%'
    OR t."lastMessage" ILIKE '¡Hola %Gracias por tu interés%'
  );
