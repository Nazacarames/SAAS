require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 await c.query("update contacts set number='5491127713231' where regexp_replace(coalesce(number,''),'\\D','','g') in ('1127713231','5491127713231')");
 const r=await c.query("select id,name,number from contacts where regexp_replace(coalesce(number,''),'\\D','','g')='5491127713231' order by id desc limit 5");
 console.log(r.rows);
 await c.end();
})();