require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const base = 'http://127.0.0.1:4000/api/whatsapp-cloud/webhook';
const phone = '5493415551234';
const runId = Date.now().toString().slice(-6);

function payload(id, text, ts) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id, from: phone, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] };
}

async function postWebhook(p) {
  const body = JSON.stringify(p);
  const headers = { 'content-type': 'application/json' };
  const secret = process.env.WA_CLOUD_APP_SECRET || '';
  if (secret) headers['x-hub-signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const r = await fetch(base, { method: 'POST', headers, body });
  console.log('webhook', r.status, (await r.text()).slice(0, 140));
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  await postWebhook(payload(`wamid.sim.${runId}.1`, 'hola, estoy buscando departamento en pichincha', now));
  await new Promise(r => setTimeout(r, 1200));
  await postWebhook(payload(`wamid.sim.${runId}.2`, 'presupuesto entre 120k y 170k usd, 2 dormitorios', now + 1));
  await new Promise(r => setTimeout(r, 1800));
  await postWebhook(payload(`wamid.sim.${runId}.3`, 'mostrame opciones por favor', now + 2));
  await new Promise(r => setTimeout(r, 2500));

  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };

  const client = new Client(cfg);
  await client.connect();
  const rs = await client.query(
    `select m."createdAt" as at, m."fromMe" as from_me, left(coalesce(m.body,''),180) as body
     from messages m
     join contacts c on c.id = m."contactId"
     where regexp_replace(coalesce(c.number,''),'\\D','','g') = $1
     order by m."createdAt" desc
     limit 14`,
    [phone]
  );
  console.log('--- transcript(last14) ---');
  rs.rows.reverse().forEach(r => console.log(`${new Date(r.at).toISOString()} | ${r.from_me ? 'BOT' : 'USER'} | ${r.body}`));
  await client.end();
})();
