require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const r=await c.query("select phone_number_id,access_token from meta_connections where status='connected' order by id desc limit 1");
 await c.end();
 const {phone_number_id,access_token}=r.rows[0];
 const u=`https://graph.facebook.com/v21.0/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,new_name_status,status,whatsapp_business_account_id`;
 const resp=await fetch(u,{headers:{Authorization:`Bearer ${access_token}`}});
 console.log('phone_status',resp.status);
 const data=await resp.text();
 console.log(data);
 try{
  const j=JSON.parse(data);
  if(j.whatsapp_business_account_id){
    const u2=`https://graph.facebook.com/v21.0/${j.whatsapp_business_account_id}/message_templates?limit=50`;
    const r2=await fetch(u2,{headers:{Authorization:`Bearer ${access_token}`}});
    console.log('templates_status',r2.status);
    console.log(await r2.text());
  }
 }catch{}
})();