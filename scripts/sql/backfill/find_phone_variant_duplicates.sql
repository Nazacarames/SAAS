WITH normalized AS (
  SELECT c.id, c."companyId", c.name, c.number, c.email,
         regexp_replace(COALESCE(c.number,''), '\\D', '', 'g') AS digits,
         RIGHT(regexp_replace(COALESCE(c.number,''), '\\D', '', 'g'), 10) AS last10
  FROM contacts c
  WHERE COALESCE(c."isGroup", false) = false
), grouped AS (
  SELECT "companyId", last10, COUNT(*) AS qty, array_agg(id ORDER BY id) AS ids
  FROM normalized
  WHERE last10 <> ''
  GROUP BY "companyId", last10
  HAVING COUNT(*) > 1
)
SELECT g."companyId", g.last10, g.qty, g.ids,
       string_agg(n.id || ':' || n.number || ':' || n.name, ' | ' ORDER BY n.id) AS detail
FROM grouped g
JOIN normalized n ON n."companyId" = g."companyId" AND n.last10 = g.last10
GROUP BY g."companyId", g.last10, g.qty, g.ids
ORDER BY g.qty DESC, g."companyId", g.last10;
