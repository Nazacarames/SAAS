SELECT COUNT(*) AS meta_events_24h FROM meta_lead_events WHERE created_at >= NOW()-interval '24 hours';
SELECT COALESCE(MAX(created_at)::text,'-') AS last_meta_event_at FROM meta_lead_events;
SELECT COUNT(*) AS contacts_created_24h FROM contacts WHERE "createdAt" >= NOW()-interval '24 hours';
SELECT COALESCE(MAX("createdAt")::text,'-') AS last_contact_created_at FROM contacts;
