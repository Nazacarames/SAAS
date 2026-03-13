#!/usr/bin/env node
const { Client } = require('pg');
const fs = require('fs');
for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i=l.indexOf('=');
  process.env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}

async function fetchFormName(formId, token) {
  const u = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(formId)}`);
  u.searchParams.set('fields','name');
  u.searchParams.set('access_token', token);
  const r = await fetch(u.toString());
  const j = await r.json().catch(()=>({}));
  if (r.ok && j?.name) return String(j.name).trim();
  return '';
}

(async()=>{
  const db = new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME});
  await db.connect();

  const conn = (await db.query('SELECT company_id, access_token FROM meta_connections ORDER BY id DESC LIMIT 1')).rows[0];
  if (!conn?.access_token) {
    console.log('[meta-form-backfill] no access token');
    await db.end();
    return;
  }

  const forms = (await db.query(`
    SELECT DISTINCT form_id
    FROM meta_lead_events
    WHERE COALESCE(form_id,'')<>''
      AND (COALESCE(form_name,'')='' OR form_name ~* '^Formulario\\s+[0-9]+$')
    ORDER BY form_id
    LIMIT 200
  `)).rows.map(r=>String(r.form_id||'').trim()).filter(Boolean);

  let updatedForms=0;
  for (const formId of forms) {
    const name = await fetchFormName(formId, String(conn.access_token));
    if (!name) continue;

    await db.query(
      `UPDATE meta_lead_events SET form_name=$1, updated_at=NOW() WHERE form_id=$2 AND (COALESCE(form_name,'')='' OR form_name ~* '^Formulario\\s+[0-9]+$')`,
      [name, formId]
    );

    await db.query(
      `UPDATE contacts c
       SET source=$1, "updatedAt"=NOW()
       WHERE c.source = ('Formulario ' || $2)
          OR c.source ~* ('^meta_form_' || $2 || '$')`,
      [name, formId]
    );

    updatedForms++;
    console.log('[meta-form-backfill] form', formId, '=>', name);
  }

  console.log('[meta-form-backfill] forms_checked=',forms.length,'forms_updated=',updatedForms);
  await db.end();
})();
