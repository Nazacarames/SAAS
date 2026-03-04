const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: '127.0.0.1',
    user: 'atendechat_user',
    password: 'Atendechat2026!',
    database: 'atendechat',
    port: 5432
  });
  await client.connect();

  const tok = await client.query("SELECT access_token FROM meta_connections WHERE company_id=1 ORDER BY id DESC LIMIT 1");
  const accessToken = tok.rows?.[0]?.access_token;
  if (!accessToken) throw new Error('No access token in meta_connections');

  const rows = await client.query(`
    SELECT id, leadgen_id
    FROM meta_lead_events
    WHERE company_id = 1
      AND COALESCE(NULLIF(TRIM(contact_phone), ''), NULLIF(TRIM(contact_email), '')) IS NULL
      AND COALESCE(NULLIF(TRIM(leadgen_id), ''), '') <> ''
    ORDER BY id DESC
    LIMIT 100
  `);

  let updated = 0;
  for (const r of rows.rows) {
    const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(r.leadgen_id)}`);
    url.searchParams.set('fields', 'id,field_data');
    url.searchParams.set('access_token', accessToken);

    const resp = await fetch(url.toString());
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !Array.isArray(data.field_data)) continue;

    const get = (name) => {
      const f = data.field_data.find((x) => String(x?.name || '').toLowerCase() === name);
      return f?.values?.[0] || '';
    };
    const phone = String(get('phone_number') || get('telefono') || '').trim();
    const email = String(get('email') || '').trim();
    const fullName = String(get('full_name') || get('nombre') || '').trim();

    if (!phone && !email && !fullName) continue;

    await client.query(
      `UPDATE meta_lead_events
       SET contact_phone = COALESCE(NULLIF($1,''), contact_phone),
           contact_email = COALESCE(NULLIF($2,''), contact_email),
           contact_name = COALESCE(NULLIF($3,''), contact_name),
           form_fields_json = CASE WHEN form_fields_json = '[]' OR form_fields_json = '{}' THEN $4 ELSE form_fields_json END,
           updated_at = NOW()
       WHERE id = $5`,
      [phone, email, fullName, JSON.stringify(data.field_data), r.id]
    );
    updated++;
  }

  console.log({ scanned: rows.rows.length, updated });
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
