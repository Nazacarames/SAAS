require('dotenv').config();
const { Client } = require('pg');
(async()=>{
  const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
  const c=new Client(cfg); await c.connect();
  const r=await c.query("select event,count(*)::int as n from integration_logs where created_at > now() - interval '30 minutes' group by event order by n desc");
  console.log(r.rows);
  await c.end();
})();