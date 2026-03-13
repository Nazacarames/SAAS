WITH ev AS (
  SELECT id, company_id, created_at,
         regexp_replace(COALESCE(contact_phone,''), '\\D', '', 'g') AS phone,
         lower(COALESCE(contact_email,'')) AS email
  FROM meta_lead_events
  WHERE created_at >= NOW() - INTERVAL '24 hours'
), c AS (
  SELECT e.id AS event_id, ct.id AS contact_id
  FROM ev e
  LEFT JOIN contacts ct
    ON ct."companyId" = e.company_id
   AND (
      (e.phone <> '' AND RIGHT(regexp_replace(COALESCE(ct.number,''), '\\D','','g'),10)=RIGHT(e.phone,10))
      OR (e.email <> '' AND lower(COALESCE(ct.email,''))=e.email)
   )
), t AS (
  SELECT c.event_id, c.contact_id,
         EXISTS(SELECT 1 FROM tickets tk WHERE tk."contactId"=c.contact_id AND tk.status IN ('open','pending','closed')) AS has_ticket,
         EXISTS(SELECT 1 FROM messages m WHERE m."contactId"=c.contact_id AND m."fromMe"=true) AS has_outbound,
         EXISTS(SELECT 1 FROM contact_tags ct JOIN tags tg ON tg.id=ct."tagId" WHERE ct."contactId"=c.contact_id AND tg.name='enviado_tokko') AS has_tokko_tag
  FROM c
)
SELECT
  (SELECT COUNT(*) FROM ev) AS events_24h,
  (SELECT COUNT(*) FROM t WHERE contact_id IS NOT NULL) AS with_contact,
  (SELECT COUNT(*) FROM t WHERE has_ticket) AS with_ticket,
  (SELECT COUNT(*) FROM t WHERE has_outbound) AS with_outbound,
  (SELECT COUNT(*) FROM t WHERE has_tokko_tag) AS with_tokko_tag;
