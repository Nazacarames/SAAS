UPDATE kb_documents
SET status='ready', updated_at=NOW()
WHERE company_id=1 AND source_type='tokko_locations';

SELECT id,title,status,source_type,updated_at
FROM kb_documents
WHERE company_id=1 AND source_type='tokko_locations'
ORDER BY id DESC
LIMIT 1;
