require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ user: process.env.DB_USER, password: process.env.DB_PASS, host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME });
  await c.connect();
  const t = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  console.log('tables', t.rows.slice(0,200).map(r=>r.table_name).join(','));
  const cand=['settings','Settings','companies','company_settings','whatsapps','whatsapps'];
  for (const name of cand){
    if(t.rows.find(r=>r.table_name===name)){
      const ccols=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[name]);
      console.log('cols',name, ccols.rows.map(r=>r.column_name).join(','));
      const rows=await c.query(`SELECT * FROM \"${name}\" LIMIT 5`);
      console.log('sample',name,JSON.stringify(rows.rows).slice(0,1000));
    }
  }
  await c.end();
})();