require('dotenv').config();
const { Client } = require('pg');

(async()=>{
  const phone = '5493416192647';
  const name = 'Lead WhatsApp 2647';

  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };

  const c = new Client(cfg);
  await c.connect();

  // Ensure contact
  let contactId;
  const found = await c.query("select id from contacts where regexp_replace(coalesce(number,''),'\\D','','g')=$1 order by id desc limit 1", [phone]);
  if (found.rows[0]) {
    contactId = found.rows[0].id;
    await c.query("update contacts set name=$1, number=$2, \"updatedAt\"=now() where id=$3", [name, phone, contactId]);
  } else {
    const ins = await c.query(
      `insert into contacts (name,number,email,source,\"leadStatus\",\"assignedUserId\",\"inactivityMinutes\",\"companyId\",\"lastInteractionAt\",\"createdAt\",\"updatedAt\")
       values ($1,$2,'','manual','unread',null,30,1,now(),now(),now()) returning id`,
      [name, phone]
    );
    contactId = ins.rows[0].id;
  }

  // Ensure ticket/conversation
  const t = await c.query("select id from tickets where \"contactId\"=$1 and status in ('pending','open') order by id desc limit 1", [contactId]);
  if (!t.rows[0]) {
    const w = await c.query("select id, \"companyId\" from whatsapps order by id asc limit 1");
    if (w.rows[0]) {
      await c.query(
        `insert into tickets (\"contactId\",\"whatsappId\",\"companyId\",status,\"unreadMessages\",\"lastMessage\",bot_enabled,human_override,\"createdAt\",\"updatedAt\")
         values ($1,$2,$3,'pending',0,'',true,false,now(),now())`,
        [contactId, w.rows[0].id, w.rows[0].companyId || 1]
      );
    }
  }

  // Send approved template 'hola'
  const mc = await c.query("select phone_number_id,access_token from meta_connections where status='connected' order by id desc limit 1");
  await c.end();

  if (!mc.rows[0]) throw new Error('No meta connection');
  const { phone_number_id, access_token } = mc.rows[0];
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phone_number_id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: 'hola',
        language: { code: 'es_AR' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Naza' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Naza' }] }
        ]
      }
    })
  });

  const txt = await resp.text();
  console.log('contactId', contactId);
  console.log('send_status', resp.status);
  console.log(txt);
})();