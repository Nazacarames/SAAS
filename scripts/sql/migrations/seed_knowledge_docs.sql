WITH d1 AS (
  INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
  VALUES (
    1,
    'Playbook comercial - respuesta a leads',
    'casos_uso',
    'manual',
    'ready',
    $$Objetivo: convertir leads de Meta/WhatsApp en oportunidades reales.

Tono: breve, humano, claro y profesional en español rioplatense.

Estructura recomendada de respuesta:
1) Saludo + personalización.
2) Confirmación de interés.
3) 1-2 preguntas clave (zona, presupuesto, tipo de unidad, plazo).
4) Próximo paso concreto (visita, llamada, propuesta).

Reglas:
- No inventar datos ni disponibilidad.
- Si falta dato crítico, pedirlo de forma directa.
- Siempre cerrar con CTA concreto.
- Evitar mensajes largos sin acción.

Manejo de objeciones:
- Precio: ofrecer rango y opciones.
- Tiempo: proponer llamada corta o visita.
- Duda general: resumir beneficios y pedir criterio principal.
$$,
    NOW(),
    NOW()
  ) RETURNING id, content
), d2 AS (
  INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
  VALUES (
    1,
    'Pipeline comercial y criterios de fase',
    'general',
    'manual',
    'ready',
    $$Fases estándar del lead:
- nuevo_ingreso: lead recién creado.
- primer_contacto: ya hubo primer mensaje/saludo.
- esperando_respuesta: se envió propuesta/pregunta y falta respuesta.
- calificacion: lead con datos clave de intención.
- propuesta: se compartió propuesta/cotización.
- cierre: lead con intención alta de avanzar.
- concretado: cierre confirmado.

Criterios prácticos:
- Mensajes de interés inicial -> primer_contacto.
- Consulta de condiciones + datos concretos -> calificacion.
- Pedido de precios/formas de pago -> propuesta.
- Reserva / cerrar / avanzar hoy -> cierre.
- Confirmación final -> concretado.
$$,
    NOW(),
    NOW()
  ) RETURNING id, content
), d3 AS (
  INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
  VALUES (
    1,
    'Operación CRM y saneamiento de conversaciones',
    'faq',
    'manual',
    'ready',
    $$Checklist operativo:
- Todo lead nuevo debe tener contacto y ticket abierto en CRM.
- Al enviar template de bienvenida, reflejar texto en conversación.
- Si no entra inbound, validar webhook, firma y suscripciones Meta.
- Revisar token vigente y phone_number_id correcto.
- Evitar duplicados con idempotency key y control anti-replay.

Buenas prácticas:
- Mantener una sola etiqueta principal de fase.
- No mezclar mensajes de distintos contactos.
- Cuando falle enrich de leadgen, reintentar y backfill.
- Si un formulario no resuelve nombre, marcar como “Formulario Meta (nombre no disponible)”.
$$,
    NOW(),
    NOW()
  ) RETURNING id, content
), all_docs AS (
  SELECT * FROM d1
  UNION ALL
  SELECT * FROM d2
  UNION ALL
  SELECT * FROM d3
)
INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
SELECT
  ad.id,
  row_number() OVER (PARTITION BY ad.id ORDER BY (SELECT 1)) - 1 AS chunk_index,
  btrim(part) AS chunk_text,
  GREATEST(1, length(btrim(part)) / 4) AS token_count,
  '[]',
  NOW(),
  NOW()
FROM all_docs ad,
LATERAL regexp_split_to_table(ad.content, E'\n\n+') AS part
WHERE btrim(part) <> '';
