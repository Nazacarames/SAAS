require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const base='http://127.0.0.1:4000/api/whatsapp-cloud/webhook';
const secret=process.env.WA_CLOUD_APP_SECRET||'ac837baf1c7246e6376fac174001560a';
const phone='549341'+Date.now().toString().slice(-6);
const msgs=['no me funciona login','quiero comprar casa en rosario centro','pasame links'];
function pl(id,text,ts){return {object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id,from:phone,timestamp:String(ts),type:'text',text:{body:text}}]}}]}]};}
(async()=>{
 for(let i=0;i<msgs.length;i++){const body=JSON.stringify(pl('wamid.qv.'+i,msgs[i],Math.floor(Date.now()/1000)+i));const sig=crypto.createHmac('sha256',secret).update(body,'utf8').digest('hex');const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+sig},body});console.log('w',r.status);await new Promise(x=>setTimeout(x,1400));}
 await new Promise(x=>setTimeout(x,7000));
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const rs=await c.query(`select m."fromMe",left(m.body,220) as body from messages m join contacts c on c.id=m."contactId" where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1 order by m."createdAt" asc`,[phone]);
 rs.rows.forEach(r=>console.log((r.fromMe?'BOT':'USER')+' | '+r.body));
 await c.end();
})();