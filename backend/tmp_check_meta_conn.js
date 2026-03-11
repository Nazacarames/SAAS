require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
      };

  const c = new Client(cfg);
  await c.connect();

  const r1 = await c.query('select id, company_id, phone_number_id, status, created_at, updated_at from meta_connections order by id desc limit 5');
  console.log('meta_connections:', r1.rows);

  await c.end();
})();