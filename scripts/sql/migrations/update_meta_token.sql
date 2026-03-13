UPDATE meta_connections
SET access_token = 'EAAUDWedCKIkBQZC8PzT59ZAHZCKwGivEwKAZAvD8zJg6L6GLA0ITtDuHw2yAhArVaJlDKiVTZBstg3lq545lQrObuu04jTaK2Njth62iBo23jILQe5iLznlGdAfTjgOJguMx89wUEeOIGnFXbKRQ45wujdgiwGRCW8yG2ZAFXPAg1krJrMWnFt9niT5CxjDe7MrgZDZD',
    updated_at = NOW()
WHERE company_id = 1;

SELECT id, company_id, phone_number_id, LENGTH(access_token) AS token_len, updated_at
FROM meta_connections
WHERE company_id = 1
ORDER BY id DESC
LIMIT 1;
