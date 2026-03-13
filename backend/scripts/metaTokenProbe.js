#!/usr/bin/env node
const { Client } = require('pg');
const fs = require('fs');
for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  process.env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}
(async()=>{
  const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME});
  await db.connect();
  const lead='1588415158941695';
  const row=(await db.query('SELECT access_token FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1')).rows[0];
  const token=String(row?.access_token||'');
  const u=new URL(`https://graph.facebook.com/v23.0/${lead}`);
  u.searchParams.set('fields','id,created_time,field_data,form_id');
  u.searchParams.set('access_token',token);
  const r=await fetch(u.toString());
  const txt=await r.text();
  console.log('status',r.status,'len',txt.length,'body',txt.slice(0,300));
  await db.end();
})();
