require('dotenv').config();
const { Client } = require('pg');

(async()=>{
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

  const tables = [
    'messages',
    'tickets',
    'contact_tags',
    'contacts',
    'conversation_state',
    'meta_lead_events',
    'integration_logs',
    'ai_decision_logs'
  ];

  for (const t of tables) {
    try {
      await c.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
      console.log('truncated', t);
    } catch (e) {
      console.log('skip', t, e.message);
    }
  }

  const checks = ['contacts','tickets','messages','meta_lead_events'];
  for (const t of checks) {
    try {
      const r = await c.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      console.log('count', t, r.rows[0].n);
    } catch (e) {
      console.log('count_skip', t, e.message);
    }
  }

  await c.end();
})();