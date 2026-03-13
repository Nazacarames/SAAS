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

  const conn = (await db.query('SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1')).rows[0];
  const tok = String(conn?.access_token || '');
  if (!tok) { console.log('no token'); await db.end(); return; }

  const rows = (await db.query(`
    SELECT id, source
    FROM contacts
    WHERE source ~* '^Formulario\\s+[0-9]+$'
    ORDER BY id DESC
    LIMIT 300
  `)).rows;

  let fixed = 0;
  for (const r of rows) {
    const src = String(r.source || '').trim();
    const m = src.match(/^Formulario\s+(\d+)$/i);
    if (!m) continue;
    const formId = m[1];
    const name = await fetchFormName(formId, tok);
    if (!name) continue;
    await db.query('UPDATE contacts SET source=$1, "updatedAt"=NOW() WHERE id=$2', [name, r.id]);
    fixed++;
    console.log('contact', r.id, 'form', formId, '=>', name);
  }

  console.log('fixed', fixed, 'of', rows.length);
  await db.end();
})();
