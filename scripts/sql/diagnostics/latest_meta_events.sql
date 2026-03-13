SELECT id, created_at, leadgen_id, left(contact_phone,20) AS phone, left(contact_name,30) AS name
FROM meta_lead_events
ORDER BY id DESC
LIMIT 8;
