require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(`select id,event_id,source,campaign_id,form_id,contact_phone,contact_name,created_at from meta_lead_events order by id desc limit 5`);
  console.log(JSON.stringify(r.rows, null, 2));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
