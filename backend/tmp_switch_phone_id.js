require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const newPhoneId = process.argv[2];
  const newDisplay = process.argv[3] || null;
  if (!newPhoneId) {
    console.error('Usage: node tmp_switch_phone_id.js <phone_number_id> [display]');
    process.exit(1);
  }

  const p = 'runtime-settings.json';
  const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  settings.waCloudPhoneNumberId = String(newPhoneId);
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));

  const db = new Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  await db.connect();
  const r = await db.query('SELECT id FROM meta_connections ORDER BY id DESC LIMIT 1');
  if (!r.rows.length) throw new Error('No meta_connections row');
  const id = r.rows[0].id;
  await db.query(
    'UPDATE meta_connections SET phone_number_id = $1, phone_number_display = COALESCE($2, phone_number_display), updated_at = NOW() WHERE id = $3',
    [String(newPhoneId), newDisplay, id]
  );
  await db.end();

  console.log('SWITCHED_PHONE_ID', { id, newPhoneId, newDisplay });
})();
