#!/usr/bin/env node
const { Client } = require('pg');
const fs = require('fs');
for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  process.env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}

const digits = (v='') => String(v).replace(/\D/g,'');
const pick = (fd,names)=>{
  const arr = Array.isArray(fd) ? fd : [];
  for (const n of names) {
    const f = arr.find(x => String(x?.name||'').toLowerCase() === n.toLowerCase());
    const val = Array.isArray(f?.values) ? f.values[0] : '';
    if (String(val||'').trim()) return String(val).trim();
  }
  return '';
};

(async()=>{
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT||5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });
  await db.connect();

  const rs = (await db.query(`
    SELECT id, company_id, leadgen_id, form_id
    FROM meta_lead_events
    WHERE COALESCE(leadgen_id,'')<>''
      AND (NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL
       OR COALESCE(contact_email,'')=''
       OR COALESCE(contact_name,'')=''
       OR COALESCE(form_fields_json,'') IN ('','{}','[]'))
    ORDER BY id DESC
    LIMIT 500
  `)).rows;

  let fixed = 0, checked = 0, failed = 0;

  for (const r of rs) {
    checked++;
    const tokRows = (await db.query(
      'SELECT access_token FROM meta_connections WHERE company_id=$1 ORDER BY id DESC LIMIT 3',
      [r.company_id]
    )).rows;
    const tokens = tokRows.map(x => String(x.access_token || '')).filter(Boolean);

    let data = null;
    for (const tok of tokens) {
      const u = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(r.leadgen_id)}`);
      u.searchParams.set('fields','id,created_time,field_data,form_id,ad_id,campaign_id,adgroup_id');
      u.searchParams.set('access_token', tok);
      try {
        const resp = await fetch(u.toString());
        const j = await resp.json().catch(() => ({}));
        if (resp.ok && j?.id) { data = j; break; }
      } catch {}
    }

    if (!data?.id) { failed++; continue; }

    const fd = Array.isArray(data.field_data) ? data.field_data : [];
    const phone = digits(pick(fd,['phone_number','telefono','phone','celular','whatsapp']));
    const email = pick(fd,['email']).toLowerCase();
    const name = pick(fd,['full_name','nombre','name']);

    await db.query(`
      UPDATE meta_lead_events
      SET form_fields_json = CASE WHEN COALESCE(form_fields_json,'') IN ('','{}','[]') THEN $1 ELSE form_fields_json END,
          contact_phone = CASE WHEN COALESCE(contact_phone,'')='' THEN $2 ELSE contact_phone END,
          contact_email = CASE WHEN COALESCE(contact_email,'')='' THEN $3 ELSE contact_email END,
          contact_name = CASE WHEN COALESCE(contact_name,'')='' THEN $4 ELSE contact_name END,
          form_id = COALESCE(NULLIF(form_id,''), $5),
          updated_at = NOW()
      WHERE id = $6
    `, [JSON.stringify(fd), phone || null, email || null, name || null, String(data.form_id || '') || null, r.id]);

    fixed++;
  }

  const left = (await db.query(`
    SELECT COUNT(*)::int c
    FROM meta_lead_events
    WHERE COALESCE(leadgen_id,'')<>''
      AND (NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL
       OR COALESCE(contact_email,'')=''
       OR COALESCE(contact_name,'')=''
       OR COALESCE(form_fields_json,'') IN ('','{}','[]'))
  `)).rows[0].c;

  console.log(`[meta-repair-all] checked=${checked} fixed=${fixed} failed_fetch=${failed} left=${left}`);

  // normalize contacts/tickets for recovered leads
  await db.query(`
    WITH ev AS (
      SELECT DISTINCT
        company_id,
        NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g'), '') AS phone,
        NULLIF(LOWER(COALESCE(contact_email,'')), '') AS email,
        NULLIF(COALESCE(contact_name,''), '') AS name,
        COALESCE(NULLIF(form_name,''), CASE WHEN COALESCE(form_id,'')<>'' THEN 'Formulario '||form_id ELSE 'Meta Lead Ads' END) AS source_label
      FROM meta_lead_events
      WHERE COALESCE(leadgen_id,'')<>''
    ), ins AS (
      INSERT INTO contacts (name, number, email, source, "leadStatus", "isGroup", "companyId", "createdAt", "updatedAt")
      SELECT COALESCE(name, phone, email, 'Lead Meta'), COALESCE(phone,''), COALESCE(email,''), source_label, 'nuevo_ingreso', false, company_id, NOW(), NOW()
      FROM ev e
      WHERE (phone IS NOT NULL OR email IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM contacts c
          WHERE c."companyId" = e.company_id
            AND ((e.phone IS NOT NULL AND NULLIF(REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g'), '') = e.phone)
              OR (e.email IS NOT NULL AND NULLIF(LOWER(COALESCE(c.email,'')), '') = e.email))
        )
      RETURNING id
    )
    SELECT COUNT(*) FROM ins
  `);

  await db.end();
})();
