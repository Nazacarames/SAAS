#!/usr/bin/env node
const { Client } = require('pg');
const fs = require('fs');

for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i=l.indexOf('=');
  process.env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}

const digits = (v='') => String(v).replace(/\D/g,'');
const pick = (fd,names)=>{ const arr=Array.isArray(fd)?fd:[]; for(const n of names){ const f=arr.find(x=>String(x?.name||'').toLowerCase()===n.toLowerCase()); const val=Array.isArray(f?.values)?f.values[0]:''; if(String(val||'').trim()) return String(val).trim(); } return ''; };
const helloPreview = (_firstName='Hola') => 'Template hola enviado';

(async()=>{
  const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME});
  await db.connect();

  let enriched = 0, contactsUpserted = 0, ticketsCreated = 0, tokkoSent = 0, holaSent = 0;

  const runtime = JSON.parse(fs.readFileSync('runtime-settings.json','utf8'));
  const tokkoEnabled = Boolean(runtime.tokkoEnabled);
  const tokkoApiKey = String(runtime.tokkoApiKey || process.env.TOKKO_API_KEY || '').trim();
  const tokkoBase = String(runtime.tokkoBaseUrl || 'https://www.tokkobroker.com/api/v1').replace(/\/$/, '');
  const tokkoLeadsPath = String(runtime.tokkoLeadsPath || '/webcontact/').startsWith('/') ? String(runtime.tokkoLeadsPath || '/webcontact/') : `/${String(runtime.tokkoLeadsPath || 'webcontact/')}`;
  const tokkoUrl = `${tokkoBase}${tokkoLeadsPath}?key=${encodeURIComponent(tokkoApiKey)}`;

  // 1) Enriquecer recientes con phone faltante via Graph
  const rs=(await db.query(`SELECT id, company_id, leadgen_id FROM meta_lead_events WHERE created_at >= NOW() - INTERVAL '96 hours' AND COALESCE(leadgen_id,'')<>'' AND NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') IS NULL ORDER BY id DESC LIMIT 120`)).rows;
  for(const r of rs){
    const tokRows=(await db.query('SELECT access_token FROM meta_connections WHERE company_id=$1 ORDER BY id DESC LIMIT 1',[r.company_id])).rows;
    const tok=String(tokRows[0]?.access_token||'');
    if (!tok) continue;
    const u=new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(r.leadgen_id)}`);
    u.searchParams.set('fields','id,created_time,field_data,form_id');
    u.searchParams.set('access_token',tok);
    const resp=await fetch(u.toString());
    const data=await resp.json().catch(()=>({}));
    if(!resp.ok || !data?.id) continue;
    const fd=Array.isArray(data.field_data)?data.field_data:[];
    const phone=digits(pick(fd,['phone_number','telefono','phone','celular','whatsapp']));
    const email=pick(fd,['email']).toLowerCase();
    const name=pick(fd,['full_name','nombre','name']);
    await db.query(`UPDATE meta_lead_events SET form_fields_json=$1, contact_phone=CASE WHEN COALESCE(contact_phone,'')='' THEN $2 ELSE contact_phone END, contact_email=CASE WHEN COALESCE(contact_email,'')='' THEN $3 ELSE contact_email END, contact_name=CASE WHEN COALESCE(contact_name,'')='' THEN $4 ELSE contact_name END, updated_at=NOW() WHERE id=$5`, [JSON.stringify(fd), phone||null, email||null, name||null, r.id]);
    enriched++;
  }

  // 2) Materializar eventos recientes en contacts/tickets si faltan
  const miss=(await db.query(`
    SELECT e.id, e.company_id, COALESCE(e.contact_name,'') AS contact_name, COALESCE(e.contact_email,'') AS contact_email,
           REGEXP_REPLACE(COALESCE(e.contact_phone,''),'\\D','','g') AS phone_norm,
           COALESCE(e.form_name,'') AS form_name, COALESCE(e.form_id,'') AS form_id
    FROM meta_lead_events e
    WHERE e.created_at >= NOW() - INTERVAL '96 hours'
      AND (
        NULLIF(REGEXP_REPLACE(COALESCE(e.contact_phone,''),'\\D','','g'),'') IS NOT NULL
        OR COALESCE(e.contact_email,'') <> ''
      )
    ORDER BY e.id DESC
    LIMIT 300
  `)).rows;

  for (const r of miss) {
    const phone = String(r.phone_norm || '');
    const email = String(r.contact_email || '').trim().toLowerCase();
    const companyId = Number(r.company_id || 0);
    if (!companyId) continue;

    const cRows = (await db.query(
      `SELECT id FROM contacts WHERE "companyId"=$1 AND (($2 <> '' AND REGEXP_REPLACE(COALESCE(number,''),'\\D','','g')=$2) OR ($3 <> '' AND LOWER(COALESCE(email,''))=$3)) ORDER BY id DESC LIMIT 1`,
      [companyId, phone, email]
    )).rows;

    let contactId = cRows[0]?.id || null;
    if (!contactId) {
      const src = String(r.form_name || (r.form_id ? `Formulario ${r.form_id}` : 'Meta Lead Ads')).trim();
      const ins = await db.query(
        `INSERT INTO contacts (name, number, email, source, "leadStatus", "isGroup", "companyId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,'nuevo_ingreso',false,$5,NOW(),NOW()) RETURNING id`,
        [String(r.contact_name || phone || 'Lead Meta'), phone, email, src, companyId]
      );
      contactId = ins.rows[0].id;
      contactsUpserted++;
    }

    const tRows = (await db.query(`SELECT id FROM tickets WHERE "companyId"=$1 AND "contactId"=$2 AND status IN ('open','pending') ORDER BY id DESC LIMIT 1`, [companyId, contactId])).rows;
    let ticketId = Number(tRows[0]?.id || 0);
    let createdTicketNow = false;
    if (!ticketId) {
      const wRows = (await db.query(`SELECT id FROM whatsapps WHERE "companyId"=$1 ORDER BY id ASC LIMIT 1`, [companyId])).rows;
      const whatsappId = Number(wRows[0]?.id || 0);
      if (whatsappId) {
        const insT = await db.query(`INSERT INTO tickets ("contactId","whatsappId","companyId",status,"unreadMessages","lastMessage","createdAt","updatedAt") VALUES ($1,$2,$3,'pending',0,'Nuevo lead Meta Ads',NOW(),NOW()) RETURNING id`, [contactId, whatsappId, companyId]);
        ticketId = Number(insT.rows[0]?.id || 0);
        ticketsCreated++;
        createdTicketNow = true;
      }
    }

    if (tokkoEnabled && tokkoApiKey && phone) {
      try {
        await db.query(`INSERT INTO tags (name,color,"createdAt","updatedAt") VALUES ('enviado_tokko','#0EA5E9',NOW(),NOW()) ON CONFLICT (name) DO NOTHING`);
        const tg = (await db.query(`SELECT id FROM tags WHERE name='enviado_tokko' LIMIT 1`)).rows[0];
        const tagId = Number(tg?.id || 0);
        let alreadyTagged = false;
        if (tagId) {
          const hasTag = await db.query(`SELECT 1 FROM contact_tags WHERE "contactId"=$1 AND "tagId"=$2 LIMIT 1`, [contactId, tagId]);
          alreadyTagged = Boolean(hasTag.rows[0]);
        }

        if (!alreadyTagged) {
          const tokResp = await fetch(tokkoUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: String(r.contact_name || phone),
              email: email,
              phone,
              text: 'Lead Meta Ads auto materializado',
              source: 'meta-repair-auto',
              tags: ['Lead_Calificado','Bot']
            })
          });
          if (tokResp.ok) {
            tokkoSent++;
            if (tagId) {
              await db.query(`INSERT INTO contact_tags ("contactId","tagId","createdAt","updatedAt") VALUES ($1,$2,NOW(),NOW()) ON CONFLICT DO NOTHING`, [contactId, tagId]);
            }
          }
        }
      } catch (_) {}
    }

    if (createdTicketNow && ticketId && phone) {
      try {
        const conn = (await db.query(`SELECT access_token, phone_number_id FROM meta_connections WHERE company_id=$1 ORDER BY id DESC LIMIT 1`, [companyId])).rows[0];
        const accessToken = String(conn?.access_token || '');
        const phoneNumberId = String(conn?.phone_number_id || '');
        const templateName = String(runtime.waFirstContactHolaTemplateName || process.env.WA_FIRST_CONTACT_HOLA_TEMPLATE_NAME || 'hola').trim();
        const templateLang = String(runtime.waFirstContactHolaTemplateLang || process.env.WA_FIRST_CONTACT_HOLA_TEMPLATE_LANG || 'es_AR').trim();
        if (accessToken && phoneNumberId && templateName) {
          const firstName = String(r.contact_name || '').trim().split(/\s+/)[0] || 'Hola';
          const waResp = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: phone,
              type: 'template',
              template: {
                name: templateName,
                language: { code: templateLang },
                components: [
                  { type: 'header', parameters: [{ type: 'text', text: firstName }] },
                  { type: 'body', parameters: [{ type: 'text', text: firstName }] }
                ]
              }
            })
          });
          const waJson = await waResp.json().catch(()=>({}));
          if (waResp.ok) {
            holaSent++;
            const providerId = String(waJson?.messages?.[0]?.id || `meta-hola-${ticketId}-${Date.now()}`);
            const preview = helloPreview(firstName);
            await db.query(`UPDATE tickets SET status='open', "lastMessage"=$1, "updatedAt"=NOW() WHERE id=$2`, [preview, ticketId]);
            await db.query(`INSERT INTO messages (id, body, "fromMe", ack, read, "mediaType", "ticketId", "contactId", "providerMessageId", "createdAt", "updatedAt") VALUES ($1,$2,true,1,true,'chat',$3,$4,$5,NOW(),NOW()) ON CONFLICT DO NOTHING`, [providerId, preview, ticketId, contactId, providerId]);
          }
        }
      } catch (_) {}
    }
  }

  const left=(await db.query(`SELECT COUNT(*)::int c FROM meta_lead_events e WHERE e.created_at >= NOW() - INTERVAL '96 hours' AND (NULLIF(REGEXP_REPLACE(COALESCE(e.contact_phone,''),'\\D','','g'),'') IS NOT NULL OR COALESCE(e.contact_email,'') <> '') AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c."companyId"=e.company_id AND ((NULLIF(REGEXP_REPLACE(COALESCE(e.contact_phone,''),'\\D','','g'),'') IS NOT NULL AND REGEXP_REPLACE(COALESCE(c.number,''),'\\D','','g')=REGEXP_REPLACE(COALESCE(e.contact_phone,''),'\\D','','g')) OR (COALESCE(e.contact_email,'')<>'' AND LOWER(COALESCE(c.email,''))=LOWER(e.contact_email))))`)).rows[0].c;

  console.log(`[metaRepairRecentMissing] enriched=${enriched} contactsUpserted=${contactsUpserted} ticketsCreated=${ticketsCreated} tokkoSent=${tokkoSent} holaSent=${holaSent} left_unmaterialized=${left}`);
  await db.end();
})();
