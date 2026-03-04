require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const qs=[
  'select count(*)::int as n from contacts',
  'select count(*)::int as n from tickets',
  'select count(*)::int as n from messages',
  'select id,name,number,"createdAt" from contacts order by id desc limit 10',
  'select id,status,"contactId","createdAt" from tickets order by id desc limit 10'
 ];
 for (const q of qs){
   const r=await c.query(q);
   console.log('\nQ:',q); console.log(r.rows);
 }
 await c.end();
})();