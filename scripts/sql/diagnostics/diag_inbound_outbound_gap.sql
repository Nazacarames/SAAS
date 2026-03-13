WITH last_inbound AS (
  SELECT m."contactId" AS contact_id, MAX(m."createdAt") AS last_in_at
  FROM messages m
  WHERE m."fromMe" = false
  GROUP BY m."contactId"
), last_outbound AS (
  SELECT m."contactId" AS contact_id, MAX(m."createdAt") AS last_out_at
  FROM messages m
  WHERE m."fromMe" = true
  GROUP BY m."contactId"
)
SELECT c.id, c.name, c.number, li.last_in_at, lo.last_out_at,
       CASE
         WHEN lo.last_out_at IS NULL THEN 'no_outbound'
         WHEN lo.last_out_at < li.last_in_at THEN 'pending_reply'
         ELSE 'replied'
       END AS state
FROM last_inbound li
JOIN contacts c ON c.id = li.contact_id
LEFT JOIN last_outbound lo ON lo.contact_id = li.contact_id
WHERE c."companyId" = 1
ORDER BY li.last_in_at DESC
LIMIT 20;
