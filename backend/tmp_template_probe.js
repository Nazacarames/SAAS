require('dotenv').config();
const { Client } = require('pg');

async function sendTemplate(phoneNumberId, token, to, name, code) {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code } }
    })
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

(async () => {
  const to = process.argv[2] || '5491127713231';
  const name = process.argv[3] || 'skygarden_captacion';

  const db = new Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  await db.connect();
  const r = await db.query('SELECT * FROM meta_connections ORDER BY id DESC LIMIT 1');
  const c = r.rows[0];
  const token = c.access_token;
  const phoneNumberId = c.phone_number_id;

  const langCodes = ['en_US', 'en', 'es_AR', 'es', 'es_ES'];
  for (const code of langCodes) {
    const out = await sendTemplate(phoneNumberId, token, to, name, code);
    console.log(code, JSON.stringify(out));
  }

  await db.end();
})();
