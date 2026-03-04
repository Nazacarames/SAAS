require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const to = process.argv[2] || '5491127713231';
  const c = new Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  await c.connect();
  const r = await c.query('SELECT company_id, phone_number_id, access_token FROM meta_connections ORDER BY id DESC LIMIT 1');
  if (!r.rows.length) {
    console.log('NO_META_CONNECTION');
    await c.end();
    return;
  }
  const row = r.rows[0];
  if (!row.phone_number_id || !row.access_token) {
    console.log('MISSING_PHONE_OR_TOKEN');
    await c.end();
    return;
  }

  const resp = await fetch(`https://graph.facebook.com/v21.0/${row.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${row.access_token}`
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: '✅ Test Charlott OAuth OK. Si te llega este mensaje, la conexión Meta/WhatsApp está funcionando.' }
    })
  });

  const data = await resp.json().catch(() => ({}));
  console.log('STATUS', resp.status);
  console.log('MESSAGE_ID', data?.messages?.[0]?.id || 'none');
  console.log('ERROR', data?.error?.message || 'none');
  await c.end();
})();
