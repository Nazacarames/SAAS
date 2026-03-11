require('dotenv').config();
const { Client } = require('pg');

(async()=>{
  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };
  const c = new Client(cfg);
  await c.connect();

  const phone = '5491127713231';
  const q1 = await c.query(`
    select c.id as contact_id, c.name, c.number, t.id as ticket_id, t.status, t."whatsappId", t."companyId"
    from contacts c
    left join tickets t on t."contactId" = c.id
    where regexp_replace(coalesce(c.number,''),'\\D','','g') = $1
    order by t.id desc nulls last
    limit 5`, [phone]);
  console.log('contact_ticket', q1.rows);

  const q2 = await c.query(`
    select id, "fromMe", ack, left(coalesce(body,''),120) as body, "providerMessageId", "createdAt"
    from messages
    where "contactId" = (select id from contacts where regexp_replace(coalesce(number,''),'\\D','','g') = $1 order by id desc limit 1)
    order by "createdAt" desc
    limit 15`, [phone]);
  console.log('messages', q2.rows);

  const q3 = await c.query(`
    select event, decision, left(coalesce(payload_json::text,'{}'),220) as payload, created_at
    from integration_logs
    where contact_id = (select id from contacts where regexp_replace(coalesce(number,''),'\\D','','g') = $1 order by id desc limit 1)
    order by created_at desc
    limit 20`, [phone]);
  console.log('integration_logs', q3.rows);

  const q4 = await c.query(`select id, phone_number_id, status, left(access_token,12) as token_prefix, length(access_token) as token_len from meta_connections order by id desc limit 3`);
  console.log('meta_connections', q4.rows);

  await c.end();
})();