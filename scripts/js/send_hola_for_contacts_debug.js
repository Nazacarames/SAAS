const fs = require('fs');
const { Client } = require('/home/deploy/atendechat/backend/node_modules/pg');
(async()=>{
 const envRaw=fs.readFileSync('/home/deploy/atendechat/backend/.env','utf8'); const env={}; for(const l of envRaw.split(/\r?\n/)){if(!l||l.startsWith('#')||!l.includes('=')) continue; const i=l.indexOf('='); env[l.slice(0,i).trim()]=l.slice(i+1).trim();}
 const rt=JSON.parse(fs.readFileSync('/home/deploy/atendechat/backend/runtime-settings.json','utf8'));
 const db=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),user:env.DB_USER,password:env.DB_PASS,database:env.DB_NAME}); await db.connect();
 const conn=(await db.query(`SELECT access_token, phone_number_id FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1`)).rows[0]||{};
 const accessToken=String(conn.access_token||''); const phoneNumberId=String(conn.phone_number_id||'');
 const templateName=String(rt.waFirstContactHolaTemplateName||'hola'); const templateLang=String(rt.waFirstContactHolaTemplateLang||'es_AR');
 const rows=(await db.query(`SELECT id,name,regexp_replace(number,'\\D','','g') AS phone FROM contacts WHERE id IN (51,52)`)).rows;
 for(const r of rows){
  const first=String(r.name||'').split(/\s+/)[0]||'Hola';
  const payload={ messaging_product:'whatsapp', to:String(r.phone), type:'template', template:{name:templateName,language:{code:templateLang},components:[{type:'body',parameters:[{type:'text',text:first}]}]} };
  const resp=await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${accessToken}`},body:JSON.stringify(payload)});
  const j=await resp.json().catch(()=>({}));
  console.log(JSON.stringify({contactId:r.id,phone:r.phone,status:resp.status,ok:resp.ok,response:j}));
 }
 await db.end();
})();