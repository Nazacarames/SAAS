require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const to = process.argv[2] || '5491127713231';
  const templateName = process.argv[3] || 'skygarden_captacion';
  const languageCode = process.argv[4] || 'en';

  const db = new Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  await db.connect();
  const r = await db.query('SELECT phone_number_id, access_token FROM meta_connections ORDER BY id DESC LIMIT 1');
  await db.end();
  if (!r.rows.length) throw new Error('No meta connection');
  const { phone_number_id, access_token } = r.rows[0];

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phone_number_id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode } }
    })
  });
  const data = await resp.json().catch(() => ({}));
  console.log(JSON.stringify({ status: resp.status, phone_number_id, to, templateName, languageCode, data }, null, 2));
})();
