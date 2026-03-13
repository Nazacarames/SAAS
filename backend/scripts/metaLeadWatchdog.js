#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function pickField(fieldData, names) {
  const arr = Array.isArray(fieldData) ? fieldData : [];
  for (const n of names) {
    const f = arr.find((x) => String(x?.name || '').toLowerCase() === n.toLowerCase());
    const val = Array.isArray(f?.values) ? f.values[0] : '';
    if (String(val || '').trim()) return String(val).trim();
  }
  return '';
}

async function fetchLeadDetails(leadgenId, tokens) {
  for (const token of tokens) {
    if (!token) continue;
    try {
      const u = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(leadgenId)}`);
      u.searchParams.set('fields', 'id,created_time,field_data,form_id,ad_id,campaign_id,adgroup_id');
      u.searchParams.set('access_token', token);
      const r = await fetch(u.toString(), { method: 'GET' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.id) return j;
    } catch (_) {}
  }
  return null;
}

async function run() {
  loadEnv(ENV_PATH);

  const db = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });
  await db.connect();

  const report = { checked: 0, enriched: 0, contactsUpserted: 0, ticketsCreated: 0, unresolved: 0 };

  const rows = (await db.query(`
    SELECT id, company_id, leadgen_id, contact_phone, contact_email, contact_name, form_id, form_name, payload_json, form_fields_json
    FROM meta_lead_events
    WHERE created_at >= NOW() - INTERVAL '72 hours'
    ORDER BY id DESC
    LIMIT 120
  `)).rows;

  for (const r of rows) {
    report.checked += 1;
    const companyId = Number(r.company_id || 0);
    const leadgenId = String(r.leadgen_id || '').trim();
    const phoneNow = digits(r.contact_phone);
    const emailNow = String(r.contact_email || '').trim().toLowerCase();
    const nameNow = String(r.contact_name || '').trim();

    if (!companyId) continue;

    const needsEnrich = Boolean(leadgenId) && !phoneNow && !emailNow && !nameNow;
    let fieldData = [];
    let phone = phoneNow;
    let email = emailNow;
    let name = nameNow;

    if (needsEnrich) {
      const appToken = (process.env.META_APP_ID && process.env.META_APP_SECRET)
        ? `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
        : '';
      const connRows = (await db.query(
        `SELECT access_token FROM meta_connections WHERE company_id = $1 ORDER BY id DESC LIMIT 3`,
        [companyId]
      )).rows;
      const tokens = [appToken, ...connRows.map((x) => String(x.access_token || ''))];
      const details = await fetchLeadDetails(leadgenId, tokens);
      if (details?.id) {
        fieldData = Array.isArray(details.field_data) ? details.field_data : [];
        phone = digits(pickField(fieldData, ['phone_number', 'telefono', 'phone']));
        email = String(pickField(fieldData, ['email'])).trim().toLowerCase();
        name = String(pickField(fieldData, ['full_name', 'nombre', 'name'])).trim();

        await db.query(
          `UPDATE meta_lead_events
           SET form_fields_json = CASE WHEN COALESCE(form_fields_json,'') = '' OR form_fields_json = '{}' THEN $1 ELSE form_fields_json END,
               contact_phone = CASE WHEN COALESCE(contact_phone,'') = '' THEN $2 ELSE contact_phone END,
               contact_email = CASE WHEN COALESCE(contact_email,'') = '' THEN $3 ELSE contact_email END,
               contact_name = CASE WHEN COALESCE(contact_name,'') = '' THEN $4 ELSE contact_name END,
               form_id = COALESCE(NULLIF(form_id,''), $5),
               updated_at = NOW()
           WHERE id = $6`,
          [JSON.stringify(fieldData || {}), phone || null, email || null, name || null, String(details.form_id || '').trim() || null, Number(r.id)]
        );
        report.enriched += 1;
      }
    }

    const finalPhone = phone || digits(r.contact_phone);
    const finalEmail = (email || String(r.contact_email || '')).trim().toLowerCase();
    const finalName = (name || String(r.contact_name || '')).trim();
    const sourceLabel = String(r.form_name || (r.form_id ? `Formulario ${r.form_id}` : 'Meta Lead Ads')).trim();

    if (!finalPhone && !finalEmail) {
      report.unresolved += 1;
      continue;
    }

    const cRows = (await db.query(
      `SELECT id, name, email, source FROM contacts
       WHERE "companyId" = $1
         AND (($2 <> '' AND REGEXP_REPLACE(COALESCE(number,''), '\\D', '', 'g') = $2)
           OR ($3 <> '' AND LOWER(COALESCE(email,'')) = $3))
       ORDER BY id DESC LIMIT 1`,
      [companyId, finalPhone || '', finalEmail || '']
    )).rows;

    let contactId = cRows[0]?.id || null;
    if (!contactId) {
      const ins = await db.query(
        `INSERT INTO contacts (name, number, email, source, "leadStatus", "isGroup", "companyId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'nuevo_ingreso', false, $5, NOW(), NOW()) RETURNING id`,
        [finalName || finalPhone || 'Lead Meta', finalPhone || '', finalEmail || '', sourceLabel, companyId]
      );
      contactId = ins.rows[0].id;
      report.contactsUpserted += 1;
    } else {
      await db.query(
        `UPDATE contacts
         SET name = CASE WHEN COALESCE(name,'') = '' THEN $1 ELSE name END,
             email = CASE WHEN COALESCE(email,'') = '' THEN $2 ELSE email END,
             source = CASE WHEN COALESCE(source,'') = '' OR source = 'meta_lead_ads' OR source = 'meta-lead-webhook' THEN $3 ELSE source END,
             "updatedAt" = NOW()
         WHERE id = $4`,
        [finalName || null, finalEmail || null, sourceLabel, contactId]
      );
    }

    const tRows = (await db.query(
      `SELECT id FROM tickets WHERE "companyId" = $1 AND "contactId" = $2 AND status IN ('open','pending') ORDER BY id DESC LIMIT 1`,
      [companyId, contactId]
    )).rows;

    if (!tRows[0]) {
      const wRows = (await db.query(`SELECT id FROM whatsapps WHERE "companyId" = $1 ORDER BY id ASC LIMIT 1`, [companyId])).rows;
      const whatsappId = Number(wRows[0]?.id || 0);
      if (whatsappId) {
        await db.query(
          `INSERT INTO tickets ("contactId", "whatsappId", "companyId", status, "unreadMessages", "lastMessage", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 'pending', 0, 'Nuevo lead Meta Ads', NOW(), NOW())`,
          [contactId, whatsappId, companyId]
        );
        report.ticketsCreated += 1;
      }
    }
  }

  console.log(`[meta-lead-watchdog] ${new Date().toISOString()} checked=${report.checked} enriched=${report.enriched} upserted=${report.contactsUpserted} tickets=${report.ticketsCreated} unresolved=${report.unresolved}`);
  await db.end();
}

run().catch((e) => {
  console.error('[meta-lead-watchdog] failed', e?.message || e);
  process.exit(1);
});
