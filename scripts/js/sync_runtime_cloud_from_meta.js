const fs = require('fs');
const { Client } = require('/home/deploy/atendechat/backend/node_modules/pg');

(async()=>{
  const envRaw = fs.readFileSync('/home/deploy/atendechat/backend/.env','utf8');
  const env = {};
  for (const l of envRaw.split(/\r?\n/)) {
    if (!l || l.trim().startsWith('#') || !l.includes('=')) continue;
    const i = l.indexOf('=');
    env[l.slice(0,i).trim()] = l.slice(i+1).trim();
  }
  const db = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT||5432), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME });
  await db.connect();
  const q = await db.query('SELECT access_token, phone_number_id FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1');
  await db.end();
  if (!q.rows[0]) throw new Error('no meta_connections row');
  const row = q.rows[0];
  const p = '/home/deploy/atendechat/backend/runtime-settings.json';
  const d = JSON.parse(fs.readFileSync(p,'utf8'));
  d.waCloudAccessToken = String(row.access_token || '');
  d.waCloudPhoneNumberId = String(row.phone_number_id || '');
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
  console.log('synced', String(d.waCloudAccessToken||'').length, d.waCloudPhoneNumberId);
})();