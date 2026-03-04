require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const base = 'http://127.0.0.1:4000/api/whatsapp-cloud/webhook';
const phone = '5493415558899';
const runId = Date.now().toString().slice(-6);
const secret = process.env.WA_CLOUD_APP_SECRET || 'ac837baf1c7246e6376fac174001560a';

function payload(id, text, ts) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ id, from: phone, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }]
  };
}

async function postSignedWebhook(p) {
  const body = JSON.stringify(p);
  const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const r = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + sig
    },
    body
  });
  console.log('webhook', r.status, (await r.text()).slice(0, 120));
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const script = [
    'hola',
    'estoy buscando departamento para comprar en rosario centro',
    'mi presupuesto es entre 110k y 150k usd',
    'quiero 2 dormitorios y amenities, cerca del rio',
    'gracias, antes de cerrar pasame 3 propiedades concretas con link'
  ];

  for (let i = 0; i < script.length; i++) {
    await postSignedWebhook(payload(`wamid.full.${runId}.${i + 1}`, script[i], now + i));
    await wait(1800);
  }

  await wait(3500);

  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
      };

  const client = new Client(cfg);
  await client.connect();

  const rs = await client.query(
    `select m."createdAt" as at, m."fromMe" as from_me, left(coalesce(m.body,''),220) as body
     from messages m
     join contacts c on c.id = m."contactId"
     where regexp_replace(coalesce(c.number,''),'\\D','','g') = $1
     order by m."createdAt" desc
     limit 26`,
    [phone]
  );

  console.log('--- transcript(last26) ---');
  rs.rows.reverse().forEach(r => {
    console.log(`${new Date(r.at).toISOString()} | ${r.from_me ? 'BOT' : 'USER'} | ${r.body}`);
  });

  await client.end();
})();
