require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const r=await c.query("select phone_number_id,access_token from meta_connections where status='connected' order by id desc limit 1");
 await c.end();
 const x=r.rows[0];
 const resp=await fetch(`https://graph.facebook.com/v21.0/${x.phone_number_id}/messages`,{
   method:'POST',
   headers:{'Content-Type':'application/json','Authorization':`Bearer ${x.access_token}`},
   body: JSON.stringify({
     messaging_product:'whatsapp',
     to:'5491127713231',
     type:'template',
     template:{name:'hello_world', language:{code:'en_US'}}
   })
 });
 console.log('status',resp.status);
 console.log(await resp.text());
})();