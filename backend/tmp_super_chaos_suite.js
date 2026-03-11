require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const base='http://127.0.0.1:4000/api/whatsapp-cloud/webhook';
const secret=process.env.WA_CLOUD_APP_SECRET||'ac837baf1c7246e6376fac174001560a';

const scenarios = [
  {
    name: 'all_at_once_then_close',
    prompts: [
      'hola, quiero comprar casa en rosario centro, 2 o 3 dorm, tengo 180k usd, mostrame links',
      'si no hay exacto, mostrame parecido sin filtrar',
      'tambien decime zonas disponibles',
      'ok ahora pasame 3 concretas'
    ]
  },
  {
    name: 'topic_switch_support_back_to_buy',
    prompts: [
      'hola',
      'no me funciona login',
      'gracias, ahora quiero comprar departamento en funes',
      'presupuesto 120k-160k usd',
      '2 dormitorios',
      'pasame links'
    ]
  },
  {
    name: 'chaos_typos_short_msgs',
    prompts: [
      'holaa',
      'kiero comp depto',
      'ros cent',
      '200000usd',
      '2 dorm',
      'zonas?',
      'links ya',
      'si no hay da igual mandame algo'
    ]
  }
];

function makePayload(phone,id,text,ts){
  return {object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id,from:phone,timestamp:String(ts),type:'text',text:{body:text}}]}}]}]};
}

async function sendSigned(phone,id,text,ts){
  const body=JSON.stringify(makePayload(phone,id,text,ts));
  const sig=crypto.createHmac('sha256',secret).update(body,'utf8').digest('hex');
  const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+sig},body});
  return r.status;
}

(async()=>{
  const cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME };

  const client = new Client(cfg);
  await client.connect();

  for (const sc of scenarios) {
    const run = Date.now().toString().slice(-6);
    const phone='549341'+run;
    console.log('\n=== scenario:',sc.name,'phone',phone,'===');
    for (let i=0;i<sc.prompts.length;i++) {
      const st = await sendSigned(phone,`wamid.super.${run}.${i+1}`,sc.prompts[i],Math.floor(Date.now()/1000)+i);
      console.log('webhook',i+1,st,sc.prompts[i]);
      await new Promise(r=>setTimeout(r, 1300));
    }
    await new Promise(r=>setTimeout(r, 9000));

    const rs = await client.query(
      `select m."fromMe" as from_me, left(coalesce(m.body,''),220) as body, m."createdAt" as at
       from messages m join contacts c on c.id=m."contactId"
       where regexp_replace(coalesce(c.number,''),'\\D','','g')=$1
       order by m."createdAt" asc`, [phone]);

    const botCount = rs.rows.filter(r=>r.from_me).length;
    const hasLinks = rs.rows.some(r=>r.from_me && /https?:\/\//i.test(r.body||''));
    const hasSupport = rs.rows.some(r=>r.from_me && /soporte|error|login|captura/i.test((r.body||'').toLowerCase()));

    console.log('summary', { botCount, hasLinks, hasSupport });
    rs.rows.forEach(r=>console.log((r.from_me?'BOT':'USER')+' | '+r.body));
  }

  await client.end();
})();