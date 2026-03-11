require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const r=await c.query("select waba_id,access_token from meta_connections where status='connected' order by id desc limit 1");
 await c.end();
 const {waba_id,access_token}=r.rows[0];
 const resp=await fetch(`https://graph.facebook.com/v21.0/${waba_id}/message_templates?limit=100`,{headers:{Authorization:`Bearer ${access_token}`}});
 console.log('status',resp.status);
 const txt=await resp.text();
 console.log(txt.slice(0,2000));
})();