const fs = require('fs');
const path = require('path');
const { Client } = require('/home/deploy/atendechat/backend/node_modules/pg');

(async () => {
  const rtPath = '/home/deploy/atendechat/backend/runtime-settings.json';
  const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
  if (!rt.tokkoEnabled) throw new Error('tokkoEnabled=false');

  const envRaw = fs.readFileSync('/home/deploy/atendechat/backend/.env', 'utf8');
  const env = {};
  for (const line of envRaw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const apiKey = String(rt.tokkoApiKey || env.TOKKO_API_KEY || '').trim();
  if (!apiKey) throw new Error('missing tokkoApiKey');

  const base = String(rt.tokkoBaseUrl || 'https://www.tokkobroker.com/api/v1').replace(/\/$/, '');
  const leadsPath = String(rt.tokkoLeadsPath || '/webcontact/').startsWith('/') ? String(rt.tokkoLeadsPath || '/webcontact/') : `/${String(rt.tokkoLeadsPath || 'webcontact/')}`;
  const endpoint = `${base}${leadsPath}`;
  const url = new URL(endpoint);
  url.searchParams.set('key', apiKey);

  const db = new Client({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
  });
  await db.connect();

  await db.query(`INSERT INTO tags (name, color, "createdAt", "updatedAt") VALUES ('enviado_tokko', '#0EA5E9', NOW(), NOW()) ON CONFLICT (name) DO NOTHING`);
  const tagRes = await db.query(`SELECT id FROM tags WHERE name='enviado_tokko' LIMIT 1`);
  const tagId = Number(tagRes.rows[0].id);

  const q = await db.query(`
    SELECT c.id, COALESCE(c.name,'') AS name, COALESCE(c.number,'') AS number, COALESCE(c.email,'') AS email, COALESCE(c.source,'') AS source
    FROM contacts c
    WHERE c."companyId" = 1
      AND COALESCE(c."isGroup", false) = false
      AND COALESCE(regexp_replace(c.number, '\\D', '', 'g'),'') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct."contactId" = c.id AND ct."tagId" = $1
      )
    ORDER BY c.id ASC
  `, [tagId]);

  let sent_ok = 0, failed = 0, skipped = 0;
  for (const row of q.rows) {
    const phone = String(row.number || '').replace(/\D/g, '');
    if (!phone) { skipped++; continue; }

    const payload = {
      name: String(row.name || phone).slice(0, 120),
      email: String(row.email || '').slice(0, 180),
      phone,
      text: 'Backfill automático desde Charlott CRM',
      source: String(row.source || 'backfill-existing-leads'),
      tags: ['Lead_Calificado', 'Bot']
    };

    try {
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        sent_ok++;
        await db.query(`INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt") VALUES ($1,$2,NOW(),NOW()) ON CONFLICT DO NOTHING`, [Number(row.id), tagId]);
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  console.log(JSON.stringify({ candidates: q.rows.length, sent_ok, failed, skipped, tag_id: tagId, endpoint }));
  await db.end();
})().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
