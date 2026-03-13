SELECT id, name, number, "createdAt", "companyId"
FROM contacts
WHERE regexp_replace(COALESCE(number,''), '\\D', '', 'g') LIKE '%3413002429'
   OR regexp_replace(COALESCE(number,''), '\\D', '', 'g') LIKE '%1127713231'
ORDER BY id DESC;
