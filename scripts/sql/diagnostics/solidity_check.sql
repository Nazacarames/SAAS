WITH today_events AS (
  SELECT id, company_id, created_at, leadgen_id,
         regexp_replace(COALESCE(contact_phone,''), '\\D', '', 'g') AS phone_norm,
         COALESCE(contact_email,'') AS email
  FROM meta_lead_events
  WHERE created_at::date = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
), matched AS (
  SELECT e.*, c.id AS contact_id
  FROM today_events e
  LEFT JOIN contacts c
    ON c."companyId"=e.company_id
   AND (
     (e.phone_norm <> '' AND regexp_replace(COALESCE(c.number,''), '\\D', '', 'g') = e.phone_norm)
     OR (e.email <> '' AND lower(COALESCE(c.email,'')) = lower(e.email))
   )
)
SELECT
  (SELECT COUNT(*) FROM today_events) AS events_today,
  (SELECT COUNT(*) FROM matched WHERE contact_id IS NOT NULL) AS events_with_contact,
  (SELECT COUNT(*) FROM matched m WHERE contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM tickets t WHERE t."contactId"=m.contact_id AND t.status IN ('open','pending'))) AS with_ticket_open_pending,
  (SELECT COUNT(*) FROM matched m WHERE contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct."tagId" WHERE ct."contactId"=m.contact_id AND t.name='enviado_tokko')) AS with_tokko_tag,
  (SELECT COUNT(*) FROM matched m WHERE contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages msg WHERE msg."contactId"=m.contact_id AND msg."fromMe"=true)) AS with_outbound_msg;
