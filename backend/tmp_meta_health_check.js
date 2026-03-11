require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const db = new Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME
  });
  await db.connect();
  const r = await db.query('SELECT * FROM meta_connections ORDER BY id DESC LIMIT 1');
  await db.end();
  if (!r.rows.length) return console.log('NO_CONN');
  const c = r.rows[0];
  const token = c.access_token;
  const waba = c.waba_id;
  const phone = c.phone_number_id;

  async function get(url){
    const res=await fetch(url);
    const j=await res.json().catch(()=>({}));
    return {status:res.status, data:j};
  }

  const out = {};
  out.waba_health = await get(`https://graph.facebook.com/v21.0/${waba}?fields=id,name,account_review_status,health_status,message_template_namespace&access_token=${encodeURIComponent(token)}`);
  out.phone_status = await get(`https://graph.facebook.com/v21.0/${phone}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,status,account_mode&access_token=${encodeURIComponent(token)}`);
  out.templates = await get(`https://graph.facebook.com/v21.0/${waba}/message_templates?fields=name,status,language,category,quality_score,rejected_reason&limit=20&access_token=${encodeURIComponent(token)}`);
  console.log(JSON.stringify(out,null,2));
})();
