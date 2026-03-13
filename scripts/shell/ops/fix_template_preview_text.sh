#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
UPDATE tickets t
SET "lastMessage" = '¡Hola ' || COALESCE(NULLIF(split_part(c.name, ' ', 1), ''), '¡hola!') || '! Gracias por tu interés en Skygarden. Recibimos tu solicitud desde el formulario y ya estamos preparando la información que pediste.',
    "updatedAt" = NOW()
FROM contacts c
WHERE t."contactId" = c.id
  AND (t."lastMessage" LIKE '[TEMPLATE:hola]%' OR t."lastMessage" LIKE '[TEMPLATE:%saludo inicial%');
SQL
