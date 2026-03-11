require('dotenv').config();
const sequelize = require('./dist/database').default;
const CreateContactService = require('./dist/services/ContactServices/CreateContactService').default;
const { Client } = require('pg');

(async()=>{
  try {
    const runId = Date.now().toString().slice(-6);
    const number = '549341' + runId;
    const contact = await CreateContactService({
      companyId: 1,
      name: 'Lead Test ' + runId,
      number,
      source: 'manual_test'
    });
    console.log('created_contact', { id: contact.id, number: contact.number });

    const cfg = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };
    const c = new Client(cfg); await c.connect();
    const t = await c.query('select id,status,"contactId" from tickets where "contactId"=$1 order by id desc limit 3',[contact.id]);
    console.log('tickets_for_contact', t.rows);
    await c.end();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(()=>{});
  }
})();