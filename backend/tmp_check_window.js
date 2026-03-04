require('dotenv').config();
const { Client } = require('pg');
(async()=>{
  const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
  const c=new Client(cfg); await c.connect();
  const phone='5491127713231';
  const q=`select c.id as contact_id,c.number,max(case when m."fromMe"=false then m."createdAt" end) as last_inbound,max(case when m."fromMe"=true then m."createdAt" end) as last_outbound,count(*)::int as total
  from contacts c left join messages m on m."contactId"=c.id
  where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1
  group by c.id,c.number`;
  const r=await c.query(q,[phone]);
  console.log(r.rows);
  await c.end();
})();