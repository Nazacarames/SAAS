require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const to = process.argv[2] || '5491127713231';
  const db = new Client({ user: process.env.DB_USER, password: process.env.DB_PASS, host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME });
  await db.connect();
  const r = await db.query('SELECT * FROM meta_connections ORDER BY id DESC LIMIT 1');
  const c = r.rows[0];
  const token = c.access_token;
  const phoneNumberId = c.phone_number_id;

  const out = { connection: { company_id: c.company_id, business_id: c.meta_business_id, waba_id: c.waba_id, phone_number_id: c.phone_number_id, phone_number_display: c.phone_number_display, updated_at: c.updated_at } };

  out.token_me = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(token)}`).then(x => x.json()).catch(() => ({}));
  out.phone_info = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,status&access_token=${encodeURIComponent(token)}`).then(x => x.json()).catch(() => ({}));

  const sendTextResp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: '🧪 Diagnóstico Charlott: texto libre' } })
  });
  out.send_text = { status: sendTextResp.status, data: await sendTextResp.json().catch(() => ({})) };

  const sendTplResp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } })
  });
  out.send_template = { status: sendTplResp.status, data: await sendTplResp.json().catch(() => ({})) };

  console.log(JSON.stringify(out, null, 2));
  await db.end();
}

main().catch(e => { console.error('FATAL', e?.message || e); process.exit(1); });
