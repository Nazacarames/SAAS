require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const base='http://127.0.0.1:4000/api/whatsapp-cloud/webhook';
const phone='549341'+Date.now().toString().slice(-6);
const secret=process.env.WA_CLOUD_APP_SECRET||'ac837baf1c7246e6376fac174001560a';
const msgs=[
 'si',
 'Si, quiero comprar una casa',
 'Quiero saber que zonas disponibles tenes',
 'Tengo 200.000usd para una casa en rosario centro',
 'Estas buscando?'
];
function payload(id,text,ts){return {object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id,from:phone,timestamp:String(ts),type:'text',text:{body:text}}]}}]}]};}
async function post(text,i){const body=JSON.stringify(payload(`wamid.flow.${i}`,text,Math.floor(Date.now()/1000)+i));const sig=crypto.createHmac('sha256',secret).update(body,'utf8').digest('hex');const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+sig},body});console.log('webhook',r.status);}
(async()=>{
 for(let i=0;i<msgs.length;i++){await post(msgs[i],i);await new Promise(r=>setTimeout(r,1600));}
 await new Promise(r=>setTimeout(r,7000));
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const rs=await c.query(`select m."createdAt" as at,m."fromMe" as from_me,left(coalesce(m.body,''),220) as body from messages m join contacts c on c.id=m."contactId" where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1 order by m."createdAt" desc limit 20`,[phone]);
 rs.rows.reverse().forEach(r=>console.log(`${new Date(r.at).toISOString()} | ${r.from_me?'BOT':'USER'} | ${r.body}`));
 await c.end();
})();