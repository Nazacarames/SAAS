require('dotenv').config();
const fs = require('fs');
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
  const r = await c.query('SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1');
  await c.end();
  if (!r.rows.length) {
    console.log('NO_CONN');
    process.exit(2);
  }
  const p = 'runtime-settings.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.waCloudAccessToken = r.rows[0].access_token;
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
  console.log('SYNCED_RUNTIME_TOKEN');
})();
