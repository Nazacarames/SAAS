CREATE INDEX IF NOT EXISTS idx_contacts_company_last10
ON contacts ("companyId", RIGHT(regexp_replace(COALESCE(number,''), '\\D', '', 'g'), 10))
WHERE COALESCE("isGroup", false) = false;
