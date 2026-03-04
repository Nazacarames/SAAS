require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const base = 'http://127.0.0.1:4000/api/whatsapp-cloud/webhook';
const runId = Date.now().toString().slice(-6);
const phone = '549341' + runId;
const secret = process.env.WA_CLOUD_APP_SECRET || 'ac837baf1c7246e6376fac174001560a';

const prompts = [
  'hola',
  'que sabes de ustedes?',
  'en que zonas tienen propiedades disponibles?',
  'me explicas como trabajan con compradores?',
  'quiero soporte porque no me funciona el login',
  'busco casa en rosario centro, 3 dormitorios, hasta 180k usd',
  'mostrame opciones concretas con link'
];

function payload(id, text, ts) {
  return { object:'whatsapp_business_account', entry:[{ changes:[{ value:{ messages:[{ id, from:phone, timestamp:String(ts), type:'text', text:{body:text} }] } }] }] };
}

async function post(p){
  const body = JSON.stringify(p);
  const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const r = await fetch(base,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+sig},body});
  console.log('webhook',r.status,(await r.text()).slice(0,100));
}

(async()=>{
  const now=Math.floor(Date.now()/1000);
  console.log('phone', phone);
  for(let i=0;i<prompts.length;i++){
    await post(payload(`wamid.rag.${runId}.${i+1}`, prompts[i], now+i));
    await new Promise(r=>setTimeout(r, 1800));
  }
  await new Promise(r=>setTimeout(r, 6000));

  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };
  const c = new Client(cfg); await c.connect();

  const msgs = await c.query(
    `select m."createdAt" as at, m."fromMe" as from_me, left(coalesce(m.body,''),240) as body
     from messages m join contacts c on c.id=m."contactId"
     where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1
     order by m."createdAt" desc limit 30`, [phone]);

  const events = await c.query(
    `select event, count(*)::int as n
     from integration_logs l join contacts c on c.id=l.contact_id
     where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1
       and l.created_at > now() - interval '30 minutes'
     group by event order by n desc`, [phone]);

  console.log('--- transcript(last30) ---');
  msgs.rows.reverse().forEach(r=>console.log(`${new Date(r.at).toISOString()} | ${r.from_me?'BOT':'USER'} | ${r.body}`));
  console.log('--- events ---');
  console.log(events.rows);

  await c.end();
})();
