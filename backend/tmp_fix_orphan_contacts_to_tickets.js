require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const w = await c.query('select id, "companyId" from whatsapps order by id asc limit 1');
 if (!w.rows[0]) { console.log('no whatsapp row'); await c.end(); return; }
 const whatsappId = w.rows[0].id;
 const companyId = w.rows[0].companyId || 1;
 const ins = await c.query(
   `insert into tickets ("contactId","whatsappId","companyId",status,"unreadMessages","lastMessage","bot_enabled","human_override","createdAt","updatedAt")
    select c.id, $1, coalesce(c."companyId",$2), 'pending', 0, '', true, false, now(), now()
    from contacts c
    left join tickets t on t."contactId"=c.id and t.status in ('pending','open')
    where t.id is null
    returning id,"contactId",status`, [whatsappId, companyId]
 );
 console.log('created_tickets', ins.rows);
 const counts = await c.query('select (select count(*)::int from contacts) as contacts, (select count(*)::int from tickets) as tickets');
 console.log('counts', counts.rows[0]);
 await c.end();
})();