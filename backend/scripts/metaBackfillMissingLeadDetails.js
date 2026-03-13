#!/usr/bin/env node
const { Client } = require('pg');
const fs = require('fs');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i=line.indexOf('=');
    const k=line.slice(0,i).trim();
    const v=line.slice(i+1).trim();
    if (!(k in process.env)) process.env[k]=v;
  }
}

function getField(fd, names){
  const arr=Array.isArray(fd)?fd:[];
  for(const n of names){
    const f=arr.find(x=>String(x?.name||'').toLowerCase()===n.toLowerCase());
    const v=Array.isArray(f?.values)?f.values[0]:'';
    if(String(v||'').trim()) return String(v).trim();
  }
  return '';
}

(async()=>{
  loadEnv('.env');
  const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME});
  await db.connect();

  const rows=(await db.query(`SELECT id, company_id, leadgen_id FROM meta_lead_events WHERE COALESCE(leadgen_id,'')<>'' AND NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL ORDER BY id DESC LIMIT 60`)).rows;
  let fixed=0, tried=0;
  for(const r of rows){
    const companyId=Number(r.company_id||0); const leadgenId=String(r.leadgen_id||'').trim(); if(!companyId||!leadgenId) continue;
    const tokRows=(await db.query('SELECT access_token FROM meta_connections WHERE company_id=$1 ORDER BY id DESC LIMIT 3',[companyId])).rows;
    const tokens=tokRows.map(x=>String(x.access_token||'')).filter(Boolean);
    let data=null;
    for(const token of tokens){
      tried++;
      const u=new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(leadgenId)}`);
      u.searchParams.set('fields','id,created_time,field_data,form_id,ad_id,campaign_id,adgroup_id');
      u.searchParams.set('access_token',token);
      const resp=await fetch(u.toString());
      const j=await resp.json().catch(()=>({}));
      if(resp.ok && j?.id){ data=j; break; }
    }
    if(!data) continue;
    const fd=Array.isArray(data.field_data)?data.field_data:[];
    const phone=getField(fd,['phone_number','telefono','phone']).replace(/\D/g,'');
    const email=getField(fd,['email']).toLowerCase();
    const name=getField(fd,['full_name','nombre','name']);
    await db.query(`UPDATE meta_lead_events SET form_fields_json=CASE WHEN COALESCE(form_fields_json,'')='' OR form_fields_json='{}' OR form_fields_json='[]' THEN $1 ELSE form_fields_json END, contact_phone=CASE WHEN COALESCE(contact_phone,'')='' THEN $2 ELSE contact_phone END, contact_email=CASE WHEN COALESCE(contact_email,'')='' THEN $3 ELSE contact_email END, contact_name=CASE WHEN COALESCE(contact_name,'')='' THEN $4 ELSE contact_name END, updated_at=NOW() WHERE id=$5`,[JSON.stringify(fd), phone||null, email||null, name||null, Number(r.id)]);
    if(phone||email||name) fixed++;
  }

  const left=(await db.query(`SELECT COUNT(*)::int c FROM meta_lead_events WHERE COALESCE(leadgen_id,'')<>'' AND NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL`)).rows[0].c;
  console.log(`[meta-backfill] rows=${rows.length} tried=${tried} fixed=${fixed} left_missing_phone_with_leadgen=${left}`);
  await db.end();
})();
