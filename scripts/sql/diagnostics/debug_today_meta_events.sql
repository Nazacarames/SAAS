WITH today_events AS (
  SELECT id, company_id, created_at, leadgen_id, form_id, form_name,
         COALESCE(contact_name,'') AS contact_name,
         COALESCE(contact_email,'') AS contact_email,
         COALESCE(contact_phone,'') AS contact_phone,
         regexp_replace(COALESCE(contact_phone,''), '\\D', '', 'g') AS phone_norm,
         COALESCE(form_fields_json,'') AS form_fields_json
  FROM meta_lead_events
  WHERE created_at::date = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
  ORDER BY id DESC
)
SELECT t.id, t.created_at, t.company_id, t.leadgen_id, t.form_name, t.contact_name, t.contact_email, t.contact_phone,
       t.phone_norm,
       CASE WHEN t.phone_norm <> '' THEN 'has_phone' ELSE 'no_phone' END AS phone_state,
       c.id AS matched_contact_id,
       c."createdAt" AS matched_contact_created_at
FROM today_events t
LEFT JOIN contacts c
  ON c."companyId" = t.company_id
 AND regexp_replace(COALESCE(c.number,''), '\\D', '', 'g') = t.phone_norm
ORDER BY t.id DESC;
