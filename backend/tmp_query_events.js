require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const phone='5493415551234';
 const q=`select l.created_at,l.event,l.decision,left(coalesce(l.payload_json::text,'{}'),220) as payload
 from integration_logs l
 join contacts c on c.id=l.contact_id
 where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1
 order by l.created_at desc limit 20`;
 const rs=await c.query(q,[phone]);
 rs.rows.reverse().forEach(r=>console.log(`${new Date(r.created_at).toISOString()} | ${r.event} | ${r.decision||''} | ${r.payload}`));
 await c.end();
})();