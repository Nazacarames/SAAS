require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  await c.connect();
  const q = await c.query("SELECT name FROM information_schema.tables WHERE table_schema='public' ORDER BY name");
  const names = q.rows.map(r=>r.name);
  console.log('HAS settings:', names.includes('settings'));
  if (names.includes('settings')) {
    const r = await c.query("SELECT key, value FROM settings WHERE key ILIKE '%meta%' OR key ILIKE '%whatsapp%' ORDER BY key");
    for (const row of r.rows) {
      console.log(row.key, String(row.value||'').slice(0,80));
    }
  }
  await c.end();
})();