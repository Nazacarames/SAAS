const fs = require('fs');
const { Client } = require('/home/deploy/atendechat/backend/node_modules/pg');

(async()=>{
  const envRaw = fs.readFileSync('/home/deploy/atendechat/backend/.env','utf8');
  const env={}; for(const l of envRaw.split(/\r?\n/)){ if(!l||l.startsWith('#')||!l.includes('=')) continue; const i=l.indexOf('='); env[l.slice(0,i).trim()]=l.slice(i+1).trim(); }
  const rt = JSON.parse(fs.readFileSync('/home/deploy/atendechat/backend/runtime-settings.json','utf8'));

  const db = new Client({ host: env.DB_HOST, port:Number(env.DB_PORT||5432), user:env.DB_USER, password:env.DB_PASS, database:env.DB_NAME });
  await db.connect();

  const conn = (await db.query(`SELECT access_token, phone_number_id FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1`)).rows[0] || {};
  const accessToken = String(conn.access_token||'');
  const phoneNumberId = String(conn.phone_number_id||'');
  const templateName = String(rt.waFirstContactHolaTemplateName || 'hola');
  const templateLang = String(rt.waFirstContactHolaTemplateLang || 'es_AR');
  if(!accessToken || !phoneNumberId) throw new Error('missing meta connection credentials');

  const rows = (await db.query(`
    WITH today_events AS (
      SELECT company_id, regexp_replace(COALESCE(contact_phone,''),'\\D','','g') AS phone_norm, COALESCE(contact_name,'') AS contact_name
      FROM meta_lead_events
      WHERE created_at::date = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    )
    SELECT DISTINCT c.id AS contact_id, c.name, regexp_replace(COALESCE(c.number,''),'\\D','','g') AS phone, t.id AS ticket_id
    FROM today_events e
    JOIN contacts c ON c."companyId"=e.company_id AND regexp_replace(COALESCE(c.number,''),'\\D','','g')=e.phone_norm
    LEFT JOIN LATERAL (
      SELECT id FROM tickets WHERE "contactId"=c.id AND "companyId"=c."companyId" ORDER BY id DESC LIMIT 1
    ) t ON true
    WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m."contactId"=c.id AND m."fromMe"=true)
  `)).rows;

  let sent=0;
  for(const r of rows){
    const firstName = String(r.name||'').trim().split(/\s+/)[0] || 'Hola';
    const resp = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`, {
      method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${accessToken}`},
      body: JSON.stringify({ messaging_product:'whatsapp', to:String(r.phone), type:'template', template:{ name:templateName, language:{code:templateLang}, components:[{type:'body', parameters:[{type:'text', text:firstName}]}] } })
    });
    const j=await resp.json().catch(()=>({}));
    if(resp.ok){
      const msgId = String(j?.messages?.[0]?.id || `meta-hola-${r.ticket_id||0}-${Date.now()}`);
      const body = `Hola ${firstName} 👋 Gracias por escribirnos. ¿Querés que te ayude con precios, ubicación o coordinar una visita?`;
      if(r.ticket_id) await db.query(`UPDATE tickets SET status='open', "lastMessage"=$1, "updatedAt"=NOW() WHERE id=$2`, [body, Number(r.ticket_id)]);
      await db.query(`INSERT INTO messages (id, body, "fromMe", ack, read, "mediaType", "ticketId", "contactId", "providerMessageId", "createdAt", "updatedAt") VALUES ($1,$2,true,1,true,'chat',$3,$4,$5,NOW(),NOW()) ON CONFLICT DO NOTHING`, [msgId, body, Number(r.ticket_id||0), Number(r.contact_id), msgId]);
      sent++;
    }
  }

  console.log(JSON.stringify({ candidates: rows.length, sent }));
  await db.end();
})().catch(e=>{ console.error(String(e?.message||e)); process.exit(1); });
