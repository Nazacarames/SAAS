SELECT c.id, c.name, c.number,
       SUM(CASE WHEN m."fromMe"=true THEN 1 ELSE 0 END) AS out_count,
       SUM(CASE WHEN m."fromMe"=false THEN 1 ELSE 0 END) AS in_count,
       MAX(m."createdAt") AS last_msg_at
FROM contacts c
LEFT JOIN messages m ON m."contactId"=c.id
WHERE c.id IN (51,52)
GROUP BY c.id,c.name,c.number
ORDER BY c.id;
