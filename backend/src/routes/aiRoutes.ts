import { Router } from "express";
import { QueryTypes } from "sequelize";
import crypto from "crypto";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import sequelize from "../database";
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";
import Message from "../models/Message";
import Whatsapp from "../models/Whatsapp";
import { getRuntimeSettings, saveRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";
import { syncLeadToTokko } from "../services/TokkoServices/TokkoService";

const aiRoutes = Router();

const chunkText = (content: string, approxChars = 3200, overlap = 400): string[] => {
  const text = String(content || '').replace(/\r/g, '').trim();
  if (!text) return [];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + approxChars);
    const slice = text.slice(cursor, end);
    out.push(slice.trim());
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out.filter(Boolean).slice(0, 500);
};

const resolveWhatsapp = async (companyId: number) => {
  const runtime = getRuntimeSettings();
  const preferredId = Number(runtime.waCloudDefaultWhatsappId || 0);
  if (preferredId > 0) {
    const byId = await Whatsapp.findByPk(preferredId as any);
    if (byId) return byId as any;
  }
  const byDefault = await Whatsapp.findOne({ where: { isDefault: true, companyId } } as any);
  if (byDefault) return byDefault as any;
  const anyWhatsapp = await Whatsapp.findOne({ where: { companyId } } as any);
  if (anyWhatsapp) return anyWhatsapp as any;
  return Whatsapp.create({ name: "WhatsApp Cloud", status: "CONNECTED", isDefault: true, companyId } as any);
};

const sendCloudText = async (to: string, text: string, companyId = 1) => {
  const settings: any = getRuntimeSettings();
  let phoneNumberId = String(settings.waCloudPhoneNumberId || '').trim();
  let accessToken = String(settings.waCloudAccessToken || '').trim();

  // Fallback: usar última conexión OAuth guardada si faltan credenciales runtime
  if (!phoneNumberId || !accessToken) {
    await ensureMetaOauthTables();
    const [conn]: any = await sequelize.query(
      `SELECT phone_number_id, access_token FROM meta_connections WHERE company_id = :companyId AND status = 'connected' ORDER BY id DESC LIMIT 1`,
      { replacements: { companyId }, type: QueryTypes.SELECT }
    );
    if (conn?.phone_number_id && conn?.access_token) {
      phoneNumberId = String(conn.phone_number_id);
      accessToken = String(conn.access_token);
    }
  }

  if (!phoneNumberId || !accessToken) throw new Error("Cloud API credentials missing");

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Cloud send failed (${resp.status})`);
  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const graphApiVersion = process.env.META_GRAPH_API_VERSION || "v21.0";
const metaOauthClientId = process.env.META_APP_ID || process.env.META_CLIENT_ID || "";
const metaOauthClientSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET || "";
const metaOauthRedirectUri = process.env.META_OAUTH_REDIRECT_URI || "";
const metaOauthStateSecret = process.env.META_OAUTH_STATE_SECRET || process.env.JWT_SECRET || "dev-meta-oauth-secret";

const getMetaOauthConfig = (req?: any) => {
  const runtime: any = getRuntimeSettings();
  const clientId = String(metaOauthClientId || runtime?.metaLeadAdsAppId || '').trim();
  const clientSecret = String(metaOauthClientSecret || runtime?.metaLeadAdsAppSecret || '').trim();
  const redirectUri = String(
    metaOauthRedirectUri ||
      runtime?.metaOauthRedirectUri ||
      `https://${req?.get?.('host') || 'login.charlott.ai'}/api/ai/meta/oauth/callback`
  ).trim();
  return { clientId, clientSecret, redirectUri };
};

let metaOauthTablesReady = false;
const ensureMetaOauthTables = async () => {
  if (metaOauthTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_oauth_states (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    user_id INTEGER,
    nonce VARCHAR(120) NOT NULL,
    state_hash VARCHAR(120) NOT NULL UNIQUE,
    redirect_after VARCHAR(700),
    status VARCHAR(40) NOT NULL DEFAULT 'pending',
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
  )`);

  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_connections (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    meta_business_id VARCHAR(120),
    waba_id VARCHAR(120),
    phone_number_id VARCHAR(120),
    phone_number_display VARCHAR(120),
    access_token TEXT NOT NULL,
    token_type VARCHAR(40),
    token_expires_at TIMESTAMP WITH TIME ZONE,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    webhook_verified_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(40) NOT NULL DEFAULT 'connected',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);

  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_meta_connections_company ON meta_connections(company_id, id DESC)`);
  metaOauthTablesReady = true;
};

const signMetaState = (payload: string) =>
  crypto.createHmac("sha256", metaOauthStateSecret).update(payload).digest("hex").slice(0, 32);

const sendCloudTextWithCredentials = async (phoneNumberId: string, accessToken: string, to: string, text: string) => {
  const resp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Cloud send failed (${resp.status})`);
  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const sendCloudTemplateWithCredentials = async (
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode = 'en'
) => {
  const resp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode } }
    })
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Cloud template send failed (${resp.status})`);
  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const scoreFromText = (text: string, current = 0) => {
  let score = Number(current || 0);
  if (/comprar|contratar|precio|plan|cotiz|demo/i.test(text)) score = Math.max(score, 65);
  if (/urgente|hoy|ahora|ya/i.test(text)) score = Math.max(score, 78);
  if (/presupuesto|interesa|quiero/i.test(text)) score = Math.max(score, 72);
  if (/gracias|resuelto|listo/i.test(text)) score = Math.max(score, 45);
  return Math.min(100, score);
};

aiRoutes.get("/agents", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const agents = await sequelize.query(
    `SELECT * FROM ai_agents WHERE company_id = :companyId ORDER BY id DESC`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return res.json(agents);
});

aiRoutes.post("/agents", isAuth, isAdmin, async (req: any, res) => {
  const { companyId } = req.user;
  const {
    name,
    persona,
    language = "es",
    model = "gpt-4o-mini",
    temperature = 0.3,
    maxTokens = 600,
    isActive = true,
    welcomeMsg = "",
    offhoursMsg = "",
    farewellMsg = "",
    businessHoursJson = "{}",
    funnelStagesJson = "[\"Nuevo\",\"Contactado\",\"Calificado\",\"Interesado\"]"
  } = req.body || {};

  const [row]: any = await sequelize.query(
    `INSERT INTO ai_agents
      (company_id, name, persona, language, model, temperature, max_tokens, is_active, welcome_msg, offhours_msg, farewell_msg, business_hours_json, funnel_stages_json, created_at, updated_at)
     VALUES
      (:companyId, :name, :persona, :language, :model, :temperature, :maxTokens, :isActive, :welcomeMsg, :offhoursMsg, :farewellMsg, :businessHoursJson, :funnelStagesJson, NOW(), NOW())
     RETURNING *`,
    {
      replacements: {
        companyId,
        name,
        persona,
        language,
        model,
        temperature,
        maxTokens,
        isActive,
        welcomeMsg,
        offhoursMsg,
        farewellMsg,
        businessHoursJson,
        funnelStagesJson
      },
      type: QueryTypes.INSERT
    }
  );

  return res.status(201).json(row);
});

aiRoutes.put("/agents/:id", isAuth, isAdmin, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;
  const fields = req.body || {};

  await sequelize.query(
    `UPDATE ai_agents
     SET
      name = COALESCE(:name, name),
      persona = COALESCE(:persona, persona),
      language = COALESCE(:language, language),
      model = COALESCE(:model, model),
      temperature = COALESCE(:temperature, temperature),
      max_tokens = COALESCE(:maxTokens, max_tokens),
      is_active = COALESCE(:isActive, is_active),
      welcome_msg = COALESCE(:welcomeMsg, welcome_msg),
      offhours_msg = COALESCE(:offhoursMsg, offhours_msg),
      farewell_msg = COALESCE(:farewellMsg, farewell_msg),
      business_hours_json = COALESCE(:businessHoursJson, business_hours_json),
      funnel_stages_json = COALESCE(:funnelStagesJson, funnel_stages_json),
      updated_at = NOW()
     WHERE id = :id AND company_id = :companyId`,
    {
      replacements: {
        id: Number(id),
        companyId,
        name: fields.name ?? null,
        persona: fields.persona ?? null,
        language: fields.language ?? null,
        model: fields.model ?? null,
        temperature: fields.temperature ?? null,
        maxTokens: fields.maxTokens ?? null,
        isActive: fields.isActive ?? null,
        welcomeMsg: fields.welcomeMsg ?? null,
        offhoursMsg: fields.offhoursMsg ?? null,
        farewellMsg: fields.farewellMsg ?? null,
        businessHoursJson: fields.businessHoursJson ?? null,
        funnelStagesJson: fields.funnelStagesJson ?? null
      },
      type: QueryTypes.UPDATE
    }
  );

  const [agent]: any = await sequelize.query(
    `SELECT * FROM ai_agents WHERE id = :id AND company_id = :companyId`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  return res.json(agent || null);
});


aiRoutes.post("/kb/documents", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { title, category = "faq", content = "" } = req.body || {};

  const [doc]: any = await sequelize.query(
    `INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
     VALUES (:companyId, :title, :category, 'manual', 'ready', :content, NOW(), NOW())
     RETURNING *`,
    { replacements: { companyId, title, category, content }, type: QueryTypes.INSERT }
  );

  // simple chunking by paragraphs
  const parts = chunkText(String(content));

  for (let i = 0; i < parts.length; i++) {
    await sequelize.query(
      `INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
       VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())`,
      {
        replacements: {
          documentId: doc.id,
          chunkIndex: i,
          chunkText: parts[i],
          tokenCount: Math.max(1, Math.floor(parts[i].length / 4))
        },
        type: QueryTypes.INSERT
      }
    );
  }

  return res.status(201).json({ document: doc, chunksCreated: parts.length });
});

aiRoutes.put("/kb/documents/:id", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;
  const { title, category, content } = req.body || {};

  const [existing]: any = await sequelize.query(
    `SELECT id, title, category, content
     FROM kb_documents
     WHERE id = :id AND company_id = :companyId
     LIMIT 1`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  if (!existing) return res.status(404).json({ error: "Documento no encontrado" });

  const nextTitle = typeof title === "string" ? title : existing.title;
  const nextCategory = typeof category === "string" ? category : existing.category;
  const nextContent = typeof content === "string" ? content : existing.content;

  await sequelize.query(
    `UPDATE kb_documents
     SET title = :title,
         category = :category,
         content = :content,
         updated_at = NOW()
     WHERE id = :id AND company_id = :companyId`,
    {
      replacements: {
        id: Number(id),
        companyId,
        title: nextTitle,
        category: nextCategory,
        content: nextContent
      },
      type: QueryTypes.UPDATE
    }
  );

  await sequelize.query(
    `DELETE FROM kb_chunks WHERE document_id = :documentId`,
    { replacements: { documentId: Number(id) }, type: QueryTypes.DELETE }
  );

  const parts = chunkText(String(nextContent));

  for (let i = 0; i < parts.length; i++) {
    await sequelize.query(
      `INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
       VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, '[]', NOW(), NOW())`,
      {
        replacements: {
          documentId: Number(id),
          chunkIndex: i,
          chunkText: parts[i],
          tokenCount: Math.max(1, Math.floor(parts[i].length / 4))
        },
        type: QueryTypes.INSERT
      }
    );
  }

  const [updated]: any = await sequelize.query(
    `SELECT d.id, d.title, d.category, d.status, d.source_type, d.created_at, d.updated_at,
            COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
     FROM kb_documents d
     WHERE d.id = :id AND d.company_id = :companyId
     LIMIT 1`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  return res.json({ ok: true, document: updated || null, chunksCreated: parts.length });
});

aiRoutes.delete("/kb/documents/:id", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;

  const [existing]: any = await sequelize.query(
    `SELECT id FROM kb_documents WHERE id = :id AND company_id = :companyId LIMIT 1`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT }
  );

  if (!existing) return res.status(404).json({ error: "Documento no encontrado" });

  await sequelize.query(
    `DELETE FROM kb_chunks WHERE document_id = :documentId`,
    { replacements: { documentId: Number(id) }, type: QueryTypes.DELETE }
  );

  await sequelize.query(
    `DELETE FROM kb_documents WHERE id = :id AND company_id = :companyId`,
    { replacements: { id: Number(id), companyId }, type: QueryTypes.DELETE }
  );

  return res.json({ ok: true, deletedId: Number(id) });
});

aiRoutes.post("/rag/search", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { query = "", limit = 5 } = req.body || {};

  const rows: any[] = await sequelize.query(
    `SELECT c.id, c.document_id, c.chunk_text, d.title, d.category,
            ts_rank_cd(c.chunk_tsv, websearch_to_tsquery('spanish', :query)) AS score
     FROM kb_chunks c
     JOIN kb_documents d ON d.id = c.document_id
     WHERE d.company_id = :companyId
       AND c.chunk_tsv @@ websearch_to_tsquery('spanish', :query)
     ORDER BY score DESC, c.id DESC
     LIMIT :limit`,
    {
      replacements: {
        companyId,
        query: String(query || ''),
        limit: Number(limit) || 5
      },
      type: QueryTypes.SELECT
    }
  );

  const compact = rows.map((r: any) => ({ id: r.id, doc: r.document_id, score: Number(r.score || 0) }));
  await sequelize.query(
    `INSERT INTO kb_search_logs (company_id, query, top_k, results_json, created_at, updated_at)
     VALUES (:companyId, :query, :topK, :resultsJson, NOW(), NOW())`,
    {
      replacements: {
        companyId,
        query: String(query),
        topK: Number(limit) || 5,
        resultsJson: JSON.stringify(compact)
      },
      type: QueryTypes.INSERT
    }
  );

  return res.json(rows);
});

aiRoutes.get("/kb/documents", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { q = "", category = "", status = "" } = req.query || {};

  const where: string[] = ["d.company_id = :companyId"];
  const replacements: any = { companyId };

  if (String(q || "").trim()) {
    where.push("(LOWER(d.title) LIKE LOWER(:qLike) OR LOWER(d.content) LIKE LOWER(:qLike))");
    replacements.qLike = `%${String(q).trim()}%`;
  }
  if (String(category || "").trim()) {
    where.push("d.category = :category");
    replacements.category = String(category).trim();
  }
  if (String(status || "").trim()) {
    where.push("d.status = :status");
    replacements.status = String(status).trim();
  }

  const rows = await sequelize.query(
    `SELECT d.id, d.title, d.category, d.status, d.source_type, d.content, d.created_at, d.updated_at,
            COALESCE((SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id), 0) AS chunks
     FROM kb_documents d
     WHERE ${where.join(" AND ")}
     ORDER BY d.id DESC
     LIMIT 500`,
    { replacements, type: QueryTypes.SELECT }
  );

  return res.json(rows);
});

aiRoutes.get("/kb/stats", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const [row]: any = await sequelize.query(
    `SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END)::int AS synced,
      SUM(CASE WHEN status <> 'ready' THEN 1 ELSE 0 END)::int AS pending,
      COUNT(DISTINCT category)::int AS categories
     FROM kb_documents
     WHERE company_id = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  return res.json(row || { total: 0, synced: 0, pending: 0, categories: 0 });
});



aiRoutes.get("/reports/leads", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { source = "", from = "", to = "" } = req.query || {};

  const where: string[] = ["company_id = :companyId"];
  const replacements: any = { companyId };
  if (String(source || "").trim()) {
    where.push("source = :source");
    replacements.source = String(source).trim();
  }
  if (String(from || "").trim()) {
    where.push("created_at >= :from");
    replacements.from = String(from).trim();
  }
  if (String(to || "").trim()) {
    where.push("created_at <= :to::date + INTERVAL '1 day'");
    replacements.to = String(to).trim();
  }

  const whereSql = where.join(" AND ");

  const [totals]: any = await sequelize.query(
    `SELECT COUNT(*)::int AS "totalLeads",
            SUM(CASE WHEN COALESCE(campaign_id,'') <> '' THEN 1 ELSE 0 END)::int AS "withCampaign",
            SUM(CASE WHEN COALESCE(form_id,'') <> '' THEN 1 ELSE 0 END)::int AS "withForm",
            SUM(CASE WHEN COALESCE(contact_phone,'') <> '' THEN 1 ELSE 0 END)::int AS "withPhone"
     FROM meta_lead_events
     WHERE ${whereSql}`,
    { replacements, type: QueryTypes.SELECT }
  );

  const bySource = await sequelize.query(
    `SELECT COALESCE(source,'sin_dato') AS source, COUNT(*)::int AS count
     FROM meta_lead_events WHERE ${whereSql} GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    { replacements, type: QueryTypes.SELECT }
  );

  const byCampaign = await sequelize.query(
    `SELECT COALESCE(campaign_id,'sin_dato') AS campaign_id, COUNT(*)::int AS count
     FROM meta_lead_events WHERE ${whereSql} GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    { replacements, type: QueryTypes.SELECT }
  );

  const byForm = await sequelize.query(
    `SELECT COALESCE(form_id,'sin_dato') AS form_id, COUNT(*)::int AS count
     FROM meta_lead_events WHERE ${whereSql} GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    { replacements, type: QueryTypes.SELECT }
  );

  const [withTicket]: any = await sequelize.query(
    `SELECT COUNT(DISTINCT m.id)::int AS count
     FROM meta_lead_events m
     LEFT JOIN contacts c ON REGEXP_REPLACE(COALESCE(c.number,''), '\D', '', 'g') = REGEXP_REPLACE(COALESCE(m.contact_phone,''), '\D', '', 'g')
     LEFT JOIN tickets t ON t."contactId" = c.id
     WHERE ${whereSql.replace('company_id', 'm.company_id')} AND t.id IS NOT NULL`,
    { replacements, type: QueryTypes.SELECT }
  );

  return res.json({ totals: { ...(totals || {}), withTicket: Number(withTicket?.count || 0) }, bySource, byCampaign, byForm });
});

aiRoutes.get("/appointments", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { from = "", to = "" } = req.query || {};

  const where: string[] = ["a.company_id = :companyId"];
  const replacements: any = { companyId };

  if (String(from || "").trim()) {
    where.push("a.starts_at >= :from");
    replacements.from = String(from).trim();
  }
  if (String(to || "").trim()) {
    where.push("a.starts_at <= :to");
    replacements.to = String(to).trim();
  }

  const rows = await sequelize.query(
    `SELECT a.*, c.name AS contact_name, c.number AS contact_number
     FROM appointments a
     JOIN contacts c ON c.id = a.contact_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.starts_at ASC
     LIMIT 500`,
    { replacements, type: QueryTypes.SELECT }
  );

  return res.json(rows);
});

aiRoutes.get("/funnel/stats", isAuth, async (req: any, res) => {
  const { companyId } = req.user;

  const [row]: any = await sequelize.query(
    `SELECT
      SUM(CASE WHEN COALESCE(c.lead_score,0) < 25 THEN 1 ELSE 0 END)::int AS nuevo,
      SUM(CASE WHEN COALESCE(c.lead_score,0) >= 25 AND COALESCE(c.lead_score,0) < 50 THEN 1 ELSE 0 END)::int AS contactado,
      SUM(CASE WHEN COALESCE(c.lead_score,0) >= 50 AND COALESCE(c.lead_score,0) < 75 THEN 1 ELSE 0 END)::int AS calificado,
      SUM(CASE WHEN COALESCE(c.lead_score,0) >= 75 THEN 1 ELSE 0 END)::int AS interesado
     FROM contacts c
     WHERE c."companyId" = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  return res.json(row || { nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });
});

aiRoutes.post("/tools/execute", isAuth, async (req: any, res) => {
  const { companyId, id: userId } = req.user;
  const { tool, args = {} } = req.body || {};

  const fail = (error: string, status = 400) => res.status(status).json({ ok: false, error });

  try {
    if (tool === "upsert_contact") {
      const number = String(args.number || "").replace(/\D/g, "");
      if (!number) return fail("number requerido");

      const [existing]: any = await sequelize.query(
        `SELECT * FROM contacts WHERE "companyId" = :companyId AND number = :number LIMIT 1`,
        { replacements: { companyId, number }, type: QueryTypes.SELECT }
      );

      if (existing) {
        await sequelize.query(
          `UPDATE contacts
           SET name = COALESCE(:name, name),
               email = COALESCE(:email, email),
               business_type = COALESCE(:businessType, business_type),
               needs = COALESCE(:needs, needs),
               "updatedAt" = NOW()
           WHERE id = :id`,
          {
            replacements: {
              id: existing.id,
              name: args.name ?? null,
              email: args.email ?? null,
              businessType: args.businessType ?? null,
              needs: args.needs ?? null
            },
            type: QueryTypes.UPDATE
          }
        );
      } else {
        await sequelize.query(
          `INSERT INTO contacts (name, number, email, isGroup, "companyId", business_type, needs, lead_score, createdAt, updatedAt)
           VALUES (:name, :number, :email, false, :companyId, :businessType, :needs, :leadScore, NOW(), NOW())`,
          {
            replacements: {
              name: args.name || number,
              number,
              email: args.email || "",
              companyId,
              businessType: args.businessType || null,
              needs: args.needs || null,
              leadScore: Number(args.leadScore || 0)
            },
            type: QueryTypes.INSERT
          }
        );
      }

      return res.json({ ok: true, tool, result: "contact upserted" });
    }

    if (tool === "actualizar_lead_score") {
      let contactId = Number(args.contactId || 0);
      const inboundText = String(args.inboundText || args.text || '').trim();
      if (!contactId) return fail("contactId requerido");

      const [existing]: any = await sequelize.query(`SELECT lead_score, "leadStatus" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`, { replacements: { contactId, companyId }, type: QueryTypes.SELECT });
      const explicitScore = Number.isFinite(Number(args.leadScore)) ? Number(args.leadScore) : null;
      const leadScore = explicitScore !== null ? Math.max(0, Math.min(100, explicitScore)) : scoreFromText(inboundText, Number(existing?.lead_score || 0));
      const leadStatus = leadScore >= 75 ? "hot" : leadScore >= 50 ? "warm" : leadScore >= 25 ? "engaged" : (existing?.leadStatus || "new");

      await sequelize.query(
        `UPDATE contacts SET lead_score = :leadScore, "leadStatus" = :leadStatus, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`,
        { replacements: { contactId, companyId, leadScore, leadStatus }, type: QueryTypes.UPDATE }
      );

      return res.json({ ok: true, tool, result: { contactId, leadScore, leadStatus } });
    }

    if (tool === "agregar_nota") {
      const contactId = Number(args.contactId || 0);
      const note = String(args.note || "").trim();
      if (!contactId || !note) return fail("contactId y note requeridos");

      await sequelize.query(
        `INSERT INTO ai_turns (conversation_id, role, content, model, latency_ms, tokens_in, tokens_out, created_at, updated_at)
         VALUES (NULL, 'tool', :content, 'manual-note', 0, 0, 0, NOW(), NOW())`,
        { replacements: { content: `[conversation:${contactId}] ${note}` }, type: QueryTypes.INSERT }
      );

      return res.json({ ok: true, tool, result: "note saved" });
    }

    if (tool === "agendar_cita") {
      const contactId = Number(args.contactId || 0);
      const startsAt = String(args.startsAt || "");
      const durationMin = Number(args.durationMin || 30);
      if (!contactId || !startsAt) return fail("contactId y startsAt requeridos");

      const end = new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();

      const [appt]: any = await sequelize.query(
        `INSERT INTO appointments (company_id, contact_id, ticket_id, starts_at, ends_at, service_type, status, notes, created_at, updated_at)
         VALUES (:companyId, :contactId, NULL, :startsAt, :endsAt, :serviceType, 'scheduled', :notes, NOW(), NOW())
         RETURNING *`,
        {
          replacements: {
            companyId,
            contactId,
            startsAt,
            endsAt: end,
            serviceType: args.serviceType || "general",
            notes: args.notes || ""
          },
          type: QueryTypes.INSERT
        }
      );

      await sequelize.query(
        `INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
         VALUES (:appointmentId, 'create', '', :createdBy, NOW(), NOW())`,
        { replacements: { appointmentId: appt.id, createdBy: userId }, type: QueryTypes.INSERT }
      );

      return res.json({ ok: true, tool, result: appt });
    }

    if (tool === "reprogramar_cita") {
      const appointmentId = Number(args.appointmentId || 0);
      const startsAt = String(args.startsAt || "");
      const durationMin = Number(args.durationMin || 30);
      if (!appointmentId || !startsAt) return fail("appointmentId y startsAt requeridos");

      const end = new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();

      await sequelize.query(
        `UPDATE appointments SET starts_at = :startsAt, ends_at = :endsAt, status='rescheduled', updated_at = NOW()
         WHERE id = :appointmentId AND company_id = :companyId`,
        { replacements: { appointmentId, companyId, startsAt, endsAt: end }, type: QueryTypes.UPDATE }
      );

      await sequelize.query(
        `INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
         VALUES (:appointmentId, 'reschedule', :reason, :createdBy, NOW(), NOW())`,
        {
          replacements: { appointmentId, reason: String(args.reason || ""), createdBy: userId },
          type: QueryTypes.INSERT
        }
      );

      return res.json({ ok: true, tool, result: "appointment rescheduled" });
    }

    if (tool === "cancelar_cita") {
      const appointmentId = Number(args.appointmentId || 0);
      if (!appointmentId) return fail("appointmentId requerido");

      await sequelize.query(
        `UPDATE appointments SET status='cancelled', updated_at = NOW() WHERE id = :appointmentId AND company_id = :companyId`,
        { replacements: { appointmentId, companyId }, type: QueryTypes.UPDATE }
      );

      await sequelize.query(
        `INSERT INTO appointment_events (appointment_id, event_type, reason, created_by, created_at, updated_at)
         VALUES (:appointmentId, 'cancel', :reason, :createdBy, NOW(), NOW())`,
        {
          replacements: { appointmentId, reason: String(args.reason || ""), createdBy: userId },
          type: QueryTypes.INSERT
        }
      );

      return res.json({ ok: true, tool, result: "appointment cancelled" });
    }

    if (tool === "consultar_conocimiento") {
      const query = String(args.query || "");
      const rows = await sequelize.query(
        `SELECT c.id, c.chunk_text, d.title, d.category,
                ts_rank_cd(c.chunk_tsv, websearch_to_tsquery('spanish', :query)) AS similarity
         FROM kb_chunks c
         JOIN kb_documents d ON d.id = c.document_id
         WHERE d.company_id = :companyId
           AND c.chunk_tsv @@ websearch_to_tsquery('spanish', :query)
         ORDER BY similarity DESC
         LIMIT 5`,
        { replacements: { companyId, query }, type: QueryTypes.SELECT }
      );

      return res.json({ ok: true, tool, result: rows });
    }

    return fail(`tool no soportada: ${tool}`);
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "tool execution error" });
  }
});


aiRoutes.get("/conversations/:conversationId/decisions", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { conversationId } = req.params;
  const n = Number(conversationId || 0);
  const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 30)));

  try {
    const rows = await sequelize.query(
      `SELECT id, ticket_id, company_id, conversation_type, decision_key, reason, guardrail_action, response_preview, created_at
       FROM ai_decision_logs
       WHERE company_id = :companyId AND (ticket_id = :id OR ticket_id IN (SELECT id FROM tickets WHERE "contactId" = :id) OR ticket_id IS NULL)
       ORDER BY id DESC
       LIMIT :limit`,
      { replacements: { companyId, id: n, limit }, type: QueryTypes.SELECT }
    );
    return res.json(rows);
  } catch (e: any) {
    return res.json([]);
  }
});

let templateTablesReady = false;
const ensureTemplateTables = async () => {
  if (templateTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS message_templates (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(60) NOT NULL DEFAULT 'general',
    channel VARCHAR(30) NOT NULL DEFAULT 'whatsapp',
    content TEXT NOT NULL,
    variables_json TEXT NOT NULL DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS template_suggestions_logs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    ticket_id INTEGER,
    contact_id INTEGER,
    query_text TEXT,
    suggested_template_id INTEGER,
    suggested_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  templateTablesReady = true;
};

aiRoutes.get('/templates', isAuth, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const rows = await sequelize.query(`SELECT * FROM message_templates WHERE company_id = :companyId ORDER BY id DESC`, { replacements: { companyId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/templates', isAuth, isAdmin, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId, id: userId } = req.user;
  const { name, category = 'general', channel = 'whatsapp', content = '', variablesJson = '[]', isActive = true } = req.body || {};
  const [row]: any = await sequelize.query(`INSERT INTO message_templates (company_id, name, category, channel, content, variables_json, is_active, created_by, created_at, updated_at)
    VALUES (:companyId, :name, :category, :channel, :content, :variablesJson, :isActive, :userId, NOW(), NOW()) RETURNING *`,
    { replacements: { companyId, name, category, channel, content, variablesJson: typeof variablesJson === 'string' ? variablesJson : JSON.stringify(variablesJson || []), isActive, userId }, type: QueryTypes.INSERT });
  return res.status(201).json(row);
});

aiRoutes.put('/templates/:id', isAuth, isAdmin, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const { id } = req.params;
  const b = req.body || {};
  await sequelize.query(`UPDATE message_templates SET
      name = COALESCE(:name, name),
      category = COALESCE(:category, category),
      channel = COALESCE(:channel, channel),
      content = COALESCE(:content, content),
      variables_json = COALESCE(:variablesJson, variables_json),
      is_active = COALESCE(:isActive, is_active),
      updated_at = NOW()
    WHERE id = :id AND company_id = :companyId`, { replacements: { id: Number(id), companyId, name: b.name ?? null, category: b.category ?? null, channel: b.channel ?? null, content: b.content ?? null, variablesJson: b.variablesJson ? (typeof b.variablesJson === 'string' ? b.variablesJson : JSON.stringify(b.variablesJson)) : null, isActive: typeof b.isActive === 'boolean' ? b.isActive : null }, type: QueryTypes.UPDATE });
  const [row]: any = await sequelize.query(`SELECT * FROM message_templates WHERE id = :id AND company_id = :companyId`, { replacements: { id: Number(id), companyId }, type: QueryTypes.SELECT });
  return res.json(row || null);
});

aiRoutes.delete('/templates/:id', isAuth, isAdmin, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const { id } = req.params;
  await sequelize.query(`DELETE FROM message_templates WHERE id = :id AND company_id = :companyId`, { replacements: { id: Number(id), companyId }, type: QueryTypes.DELETE });
  return res.json({ ok: true, deletedId: Number(id) });
});

aiRoutes.post('/templates/suggest', isAuth, async (req: any, res) => {
  await ensureTemplateTables();
  const { companyId } = req.user;
  const { contactId, query = '' } = req.body || {};
  const [row]: any = await sequelize.query(`SELECT * FROM message_templates WHERE company_id = :companyId AND is_active = true ORDER BY id DESC LIMIT 1`, { replacements: { companyId }, type: QueryTypes.SELECT });
  const suggestion = row ? { templateId: row.id, content: row.content, variables: row.variables_json } : null;
  await sequelize.query(`INSERT INTO template_suggestions_logs (company_id, ticket_id, contact_id, query_text, suggested_template_id, suggested_payload_json, created_at)
    VALUES (:companyId, NULL, :contactId, :queryText, :templateId, :payload, NOW())`, { replacements: { companyId, contactId: contactId || null, queryText: String(query || ''), templateId: suggestion?.templateId || null, payload: JSON.stringify(suggestion || {}) }, type: QueryTypes.INSERT });
  return res.json({ suggestion });
});

aiRoutes.post('/templates/send', isAuth, async (req: any, res) => {
  const { templateId, contactId, payload = {} } = req.body || {};
  return res.json({ ok: true, queued: true, templateId: Number(templateId || 0), contactId: Number(contactId || 0), payload, note: 'Scaffold: conectar envÃ­o real con canal WhatsApp/Cloud' });
});

aiRoutes.get('/meta/oauth/start', isAuth, async (req: any, res) => {
  await ensureMetaOauthTables();
  const oauth = getMetaOauthConfig(req);
  if (!oauth.clientId || !oauth.redirectUri) {
    return res.status(400).json({ ok: false, error: 'missing_meta_oauth_config', required: ['META_APP_ID|runtime.metaLeadAdsAppId', 'META_OAUTH_REDIRECT_URI'] });
  }

  const companyId = Number(req.user?.companyId || 0);
  const userId = Number(req.user?.id || 0) || null;
  const redirectAfter = String(req.query.redirectAfter || req.body?.redirectAfter || '/settings').slice(0, 650);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({ companyId, userId, nonce, ts: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = signMetaState(payloadB64);
  const state = `${payloadB64}.${sig}`;

  await sequelize.query(
    `INSERT INTO meta_oauth_states (company_id, user_id, nonce, state_hash, redirect_after, status, expires_at)
     VALUES (:companyId, :userId, :nonce, :stateHash, :redirectAfter, 'pending', NOW() + INTERVAL '10 minutes')`,
    {
      replacements: {
        companyId,
        userId,
        nonce,
        stateHash: crypto.createHash('sha256').update(state).digest('hex'),
        redirectAfter
      },
      type: QueryTypes.INSERT
    }
  );

  const scope = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
    'business_management'
  ].join(',');

  const oauthUrl = `https://www.facebook.com/${graphApiVersion}/dialog/oauth?` + new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    state,
    response_type: 'code',
    scope
  }).toString();

  return res.json({ ok: true, oauthUrl, statePreview: `${state.slice(0, 10)}...` });
});

aiRoutes.get('/meta/oauth/callback', async (req: any, res) => {
  await ensureMetaOauthTables();

  if (String(req.query.error || '')) {
    return res.status(400).send(`Meta OAuth error: ${String(req.query.error_description || req.query.error || 'unknown')}`);
  }

  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (!code || !state || !state.includes('.')) return res.status(400).send('Missing code/state');

  const [payloadB64, sig] = state.split('.', 2);
  if (signMetaState(payloadB64) !== sig) return res.status(400).send('Invalid state signature');

  const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const companyId = Number(decoded?.companyId || 0);
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');

  const [stateRow]: any = await sequelize.query(
    `SELECT * FROM meta_oauth_states
     WHERE state_hash = :stateHash AND company_id = :companyId AND status = 'pending' AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    { replacements: { stateHash, companyId }, type: QueryTypes.SELECT }
  );
  if (!stateRow) return res.status(400).send('State expired/used');

  const oauth = getMetaOauthConfig(req);
  if (!oauth.clientId || !oauth.clientSecret || !oauth.redirectUri) {
    return res.status(400).send('Missing OAuth config on server (env/runtime)');
  }

  const tokenUrl = `https://graph.facebook.com/${graphApiVersion}/oauth/access_token?` + new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: oauth.redirectUri,
    code
  }).toString();

  const tokenResp = await fetch(tokenUrl);
  const tokenData: any = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenData?.access_token) {
    return res.status(400).send(`Token exchange failed: ${tokenData?.error?.message || tokenResp.status}`);
  }

  const accessToken = String(tokenData.access_token);
  const meBusinessesResp = await fetch(`https://graph.facebook.com/${graphApiVersion}/me/businesses?fields=id,name&access_token=${encodeURIComponent(accessToken)}`);
  const meBusinesses: any = await meBusinessesResp.json().catch(() => ({}));
  const businessId = String(meBusinesses?.data?.[0]?.id || '');

  let wabaId = '';
  let phoneNumberId = '';
  let phoneDisplay = '';
  if (businessId) {
    const wabaResp = await fetch(`https://graph.facebook.com/${graphApiVersion}/${businessId}/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number}&access_token=${encodeURIComponent(accessToken)}`);
    const wabaData: any = await wabaResp.json().catch(() => ({}));
    wabaId = String(wabaData?.data?.[0]?.id || '');
    phoneNumberId = String(wabaData?.data?.[0]?.phone_numbers?.data?.[0]?.id || '');
    phoneDisplay = String(wabaData?.data?.[0]?.phone_numbers?.data?.[0]?.display_phone_number || '');
  }

  await sequelize.query(
    `INSERT INTO meta_connections (company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, access_token, token_type, token_expires_at, scopes_json, status, created_at, updated_at)
     VALUES (:companyId, :businessId, :wabaId, :phoneNumberId, :phoneDisplay, :accessToken, :tokenType, :expiresAt, :scopesJson, 'connected', NOW(), NOW())`,
    {
      replacements: {
        companyId,
        businessId: businessId || null,
        wabaId: wabaId || null,
        phoneNumberId: phoneNumberId || null,
        phoneDisplay: phoneDisplay || null,
        accessToken,
        tokenType: String(tokenData.token_type || 'bearer'),
        expiresAt: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000) : null,
        scopesJson: JSON.stringify(tokenData.scope || [])
      },
      type: QueryTypes.INSERT
    }
  );

  await sequelize.query(
    `UPDATE meta_oauth_states SET status = 'used', used_at = NOW() WHERE id = :id`,
    { replacements: { id: Number(stateRow.id) }, type: QueryTypes.UPDATE }
  );

  const redirectAfter = String(stateRow.redirect_after || '/settings');
  return res.redirect(`${redirectAfter}${redirectAfter.includes('?') ? '&' : '?'}meta_oauth=ok`);
});

aiRoutes.get('/meta/oauth/status', isAuth, async (req: any, res) => {
  await ensureMetaOauthTables();
  const { companyId } = req.user;
  const [row]: any = await sequelize.query(
    `SELECT id, company_id, meta_business_id, waba_id, phone_number_id, phone_number_display, token_expires_at, status, updated_at
     FROM meta_connections
     WHERE company_id = :companyId
     ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return res.json(row || { connected: false });
});

aiRoutes.post('/meta/oauth/test-send', isAuth, async (req: any, res) => {
  await ensureMetaOauthTables();
  const { companyId } = req.user;
  const to = String(req.body?.to || '').replace(/\D/g, '');
  const text = String(req.body?.text || 'Test exitoso desde Charlott OAuth + WhatsApp Cloud API');
  const templateName = String(req.body?.templateName || '').trim();
  const languageCode = String(req.body?.languageCode || 'en').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'missing_to' });

  const [conn]: any = await sequelize.query(
    `SELECT * FROM meta_connections WHERE company_id = :companyId ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  if (!conn?.access_token || !conn?.phone_number_id) {
    return res.status(400).json({ ok: false, error: 'missing_connection_or_phone', hint: 'Complete OAuth y selecciona WABA/numero valido' });
  }

  let messageId = '';
  if (templateName) {
    messageId = await sendCloudTemplateWithCredentials(String(conn.phone_number_id), String(conn.access_token), to, templateName, languageCode || 'en');
    return res.json({ ok: true, mode: 'template', messageId, to, phoneNumberId: conn.phone_number_id, templateName, languageCode });
  }

  messageId = await sendCloudTextWithCredentials(String(conn.phone_number_id), String(conn.access_token), to, text);
  return res.json({ ok: true, mode: 'text', messageId, to, phoneNumberId: conn.phone_number_id, text });
});

let metaLeadTablesReady = false;
const ensureMetaLeadTables = async () => {
  if (metaLeadTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS meta_lead_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    event_id VARCHAR(120),
    page_id VARCHAR(120),
    form_id VARCHAR(120),
    leadgen_id VARCHAR(120),
    ad_id VARCHAR(120),
    campaign_id VARCHAR(120),
    adset_id VARCHAR(120),
    source VARCHAR(60) DEFAULT 'meta_lead_ads',
    form_fields_json TEXT NOT NULL DEFAULT '{}',
    payload_json TEXT NOT NULL DEFAULT '{}',
    contact_phone VARCHAR(60),
    contact_email VARCHAR(160),
    contact_name VARCHAR(180),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  metaLeadTablesReady = true;
};

const ensureMetaFormsTag = async (contactId: number) => {
  const [tag]: any = await sequelize.query(
    `INSERT INTO tags (name, color, "createdAt", "updatedAt")
     VALUES ('Formularios meta', '#2563EB', NOW(), NOW())
     ON CONFLICT (name)
     DO UPDATE SET "updatedAt" = NOW()
     RETURNING id`,
    { type: QueryTypes.SELECT }
  );

  if (!tag?.id) return;

  await sequelize.query(
    `INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
     VALUES (:contactId, :tagId, NOW(), NOW())
     ON CONFLICT ("contactId", "tagId") DO NOTHING`,
    { replacements: { contactId, tagId: Number(tag.id) }, type: QueryTypes.INSERT }
  );
};



const fetchMetaLeadFieldData = async (companyId: number, leadgenId: string) => {
  try {
    if (!leadgenId) return null;
    const [conn]: any = await sequelize.query(
      `SELECT access_token FROM meta_connections WHERE company_id = :companyId AND status = 'connected' ORDER BY id DESC LIMIT 1`,
      { replacements: { companyId }, type: QueryTypes.SELECT }
    );
    const accessToken = String(conn?.access_token || '').trim();
    if (!accessToken) return null;

    const res = await fetch(`https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,form_id,ad_id,campaign_id&access_token=${encodeURIComponent(accessToken)}`);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return data?.field_data || null;
  } catch {
    return null;
  }
};

aiRoutes.get('/meta-leads/webhook', async (req: any, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const s = getRuntimeSettings();
  if (mode === 'subscribe' && token && token === String(s.metaLeadAdsWebhookVerifyToken || '')) return res.status(200).send(challenge || 'ok');
  return res.status(403).json({ ok: false, error: 'verification_failed' });
});

aiRoutes.post('/meta-leads/webhook', async (req: any, res) => {
  await ensureMetaLeadTables();
  const body = req.body || {};
  const webhookValue = body?.entry?.[0]?.changes?.[0]?.value || body?.sample?.value || body?.value || body;
  let fieldData: any = webhookValue?.form_fields || webhookValue?.field_data || body?.form_fields || body?.field_data || body?.lead?.field_data || {};
  const getField = (k: string) => {
    if (!fieldData) return '';
    if (Array.isArray(fieldData)) {
      const found = fieldData.find((x: any) => String(x?.name || '').toLowerCase() === k.toLowerCase());
      return found?.values?.[0] || '';
    }
    return fieldData[k] || '';
  };
  const companyId = Number(body.companyId || 1);
  const leadgenIdRaw = String(webhookValue?.leadgen_id || body?.leadgen_id || '');
  if ((!fieldData || (Array.isArray(fieldData) ? fieldData.length === 0 : Object.keys(fieldData || {}).length === 0)) && leadgenIdRaw) {
    const fetched = await fetchMetaLeadFieldData(companyId, leadgenIdRaw);
    if (fetched && (Array.isArray(fetched) ? fetched.length > 0 : Object.keys(fetched || {}).length > 0)) fieldData = fetched;
  }
  const syntheticSuffix = String(leadgenIdRaw || Date.now()).replace(/\D/g, '').slice(-8).padStart(8, '0');
  const syntheticPhone = `54911${syntheticSuffix}`;
  const phoneRaw = String(
    getField('phone_number') ||
      getField('telefono') ||
      webhookValue?.phone_number ||
      body.phone ||
      ''
  ).trim();
  const phone = phoneRaw.replace(/\D/g, '') || syntheticPhone;
  const isSyntheticPhone = phoneRaw.replace(/\D/g, '').length === 0;
  const formId = String(body.form_id || webhookValue?.form_id || '').trim();
  const sourceLabel = formId ? `meta_form_${formId}` : 'meta_lead_ads';
  const email = String(getField('email') || webhookValue?.email || body.email || '').trim();
  const name = String(getField('full_name') || getField('nombre') || webhookValue?.full_name || body.name || '').trim();
  const businessType = String(getField('rubro') || getField('business_type') || getField('industry') || '').trim();
  const leadNeed = String(getField('interes') || getField('interés') || getField('consulta') || getField('necesidad') || getField('mensaje') || '').trim();
  const needsPayload = leadNeed || JSON.stringify(fieldData || {}).slice(0, 900);

  await sequelize.query(`INSERT INTO meta_lead_events (company_id, event_id, page_id, form_id, leadgen_id, ad_id, campaign_id, adset_id, form_fields_json, payload_json, contact_phone, contact_email, contact_name, created_at, updated_at)
    VALUES (:companyId, :eventId, :pageId, :formId, :leadgenId, :adId, :campaignId, :adsetId, :formFieldsJson, :payloadJson, :phone, :email, :name, NOW(), NOW())`, {
      replacements: {
        companyId,
        eventId: String(body.event_id || body.id || webhookValue?.leadgen_id || ''),
        pageId: String(body.page_id || webhookValue?.page_id || body?.entry?.[0]?.id || ''),
        formId: String(body.form_id || webhookValue?.form_id || ''),
        leadgenId: String(body.leadgen_id || webhookValue?.leadgen_id || ''),
        adId: String(body.ad_id || webhookValue?.ad_id || ''),
        campaignId: String(body.campaign_id || webhookValue?.campaign_id || ''),
        adsetId: String(body.adset_id || webhookValue?.adset_id || webhookValue?.adgroup_id || ''),
        formFieldsJson: JSON.stringify(fieldData || {}),
        payloadJson: JSON.stringify(body || {}),
        phone: phoneRaw,
        email,
        name
      },
      type: QueryTypes.INSERT
    });

  // Si Meta envía payload de prueba sin phone_number, usamos teléfono sintético estable por leadgen_id.

  let contact: any = await Contact.findOne({ where: { number: phone, companyId } } as any);
  if (!contact) contact = await Contact.create({ name: name || phone, number: phone, email, source: sourceLabel, companyId, isGroup: false, lead_score: scoreFromText(JSON.stringify(fieldData || {}), 0), leadStatus: 'engaged', business_type: businessType || null, needs: needsPayload } as any);
  else await contact.update({ name: name || contact.name, email: email || contact.email, source: sourceLabel || contact.source, lead_score: scoreFromText(JSON.stringify(fieldData || {}), Number(contact.lead_score || 0)), leadStatus: 'engaged', business_type: businessType || contact.business_type || null, needs: needsPayload || contact.needs || null, updatedAt: new Date() } as any);

  try { await ensureMetaFormsTag(Number(contact.id)); } catch {}

  const whatsapp: any = await resolveWhatsapp(companyId);
  let ticket: any = await Ticket.findOne({ where: { contactId: contact.id, whatsappId: whatsapp.id }, order: [['updatedAt', 'DESC']] } as any);
  if (ticket && !['open', 'pending'].includes(String(ticket.status || ''))) ticket = null;
  if (!ticket) ticket = await Ticket.create({ contactId: contact.id, whatsappId: whatsapp.id, companyId, status: 'pending', unreadMessages: 0, lastMessage: 'Nuevo lead Meta Ads', bot_enabled: true, human_override: false } as any);

  const getLeadFieldValue = (...keys: string[]) => {
    const tries = keys.map((k) => String(k || '').toLowerCase());
    if (Array.isArray(fieldData)) {
      for (const k of tries) {
        const found: any = fieldData.find((x: any) => String(x?.name || '').toLowerCase() === k);
        const v = found?.values?.[0];
        if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
      }
      return '';
    }
    if (fieldData && typeof fieldData === 'object') {
      for (const k of tries) {
        const entry: any = (fieldData as any)[k] ?? (fieldData as any)[k.replace(/[^a-z0-9]/g, '')];
        if (entry !== undefined && entry !== null && String(entry).trim()) return String(entry).trim();
      }
    }
    return '';
  };

  const interest = getLeadFieldValue(
    'interes', 'interés', 'interest', 'consulta', 'necesidad',
    'property_type', 'tipo_propiedad', 'inmueble', 'producto'
  );
  const formContext = getLeadFieldValue('form_name', 'nombre_formulario');
  const helloName = (name || '').trim() ? ` ${name.trim()}` : '';
  const normalizedNeed = String(leadNeed || interest || '').trim();
  const needsReply = normalizedNeed
    ? `Sobre lo que nos pediste${formContext ? ` en ${formContext}` : ''} ("${normalizedNeed}"): te ayudo con eso ahora mismo. `
    : '';

  const leadOpeners = [
    `¡Hola${helloName}! 👋 ${needsReply}Gracias por completar el formulario desde Meta. Si querés, te muestro opciones concretas según eso, o ajustamos por zona/presupuesto/tipo.`,
    `¡Hola${helloName}! 👋 ${needsReply}¡Gracias por escribirnos desde Meta! Si te parece, arranco con sugerencias alineadas a lo que dejaste en el formulario.`,
    `¡Hola${helloName}! 👋 ${needsReply}Ya vi tu formulario. ¿Querés que empecemos por opciones sugeridas o preferís que afinemos primero algún detalle?`
  ];
  const outreach = leadOpeners[Math.floor(Math.random() * leadOpeners.length)];

  if (isSyntheticPhone) return res.json({ ok: true, ingested: true, outreach: false, skippedReason: 'meta_phone_missing', contactId: contact.id });

  try {
    const outId = await sendCloudText(phone, outreach, companyId);
    await Message.create({ id: outId, body: outreach, contactId: contact.id, fromMe: true, read: true, ack: 1, mediaType: 'chat' } as any);
    await ticket.update({ status: ticket.status === 'pending' ? 'open' : ticket.status, lastMessage: outreach, updatedAt: new Date() } as any);
  } catch (e: any) {
    await logIntegrationError({
      companyId,
      source: 'meta',
      severity: 'high',
      errorCode: 'META_LEAD_OUTREACH_SEND_ERROR',
      message: String(e?.message || e || 'meta outreach send error'),
      suggestion: 'Verificar credenciales de WhatsApp Cloud y número vinculado',
      payload: { phone, contactId: contact.id }
    });
    // do not fail webhook ack
  }

  return res.json({ ok: true, ingested: true, outreach: true, contactId: contact.id });
});

aiRoutes.get('/meta-leads/context/:phone', isAuth, async (req: any, res) => {
  await ensureMetaLeadTables();
  const { companyId } = req.user;
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  const [row]: any = await sequelize.query(`SELECT id, form_id, campaign_id, ad_id, contact_name, contact_email, form_fields_json, created_at
    FROM meta_lead_events
    WHERE company_id = :companyId AND REGEXP_REPLACE(COALESCE(contact_phone,''), '\\D', '', 'g') = :phone
    ORDER BY id DESC LIMIT 1`, { replacements: { companyId, phone }, type: QueryTypes.SELECT });
  return res.json(row || null);
});

let crmFeatureTablesReady = false;
const ensureCrmFeatureTables = async () => {
  if (crmFeatureTablesReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS internal_notes (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    mentions_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS integration_errors (
    id SERIAL PRIMARY KEY,
    company_id INTEGER,
    source VARCHAR(30) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    error_code VARCHAR(120),
    message TEXT NOT NULL,
    suggestion TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS followup_sequences (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    ticket_id INTEGER,
    contact_id INTEGER,
    day_offset INTEGER NOT NULL,
    template_text TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    executed_at TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(180),
    sequence_group VARCHAR(180),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(180)`);
  await sequelize.query(`ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS sequence_group VARCHAR(180)`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_company_idempotency ON followup_sequences(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

  await sequelize.query(`CREATE TABLE IF NOT EXISTS lead_score_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    previous_score INTEGER,
    new_score INTEGER NOT NULL,
    previous_status VARCHAR(30),
    new_status VARCHAR(30),
    reason VARCHAR(120) NOT NULL DEFAULT 'manual',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  )`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_lead_score_events_company_contact ON lead_score_events(company_id, contact_id, id DESC)`);
  crmFeatureTablesReady = true;
};

const parseMentions = (text: string) => Array.from(new Set((String(text || '').match(/@([a-zA-Z0-9_.-]{2,40})/g) || []).map((m) => m.slice(1).toLowerCase())));
const renderTemplate = (template: string, vars: Record<string, any>) => String(template || '').replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_m, key) => String(vars?.[key] ?? ''));

const scoreLead = ({ source = '', interactions = 0, inactiveDays = 0, tags = [] }: { source?: string; interactions?: number; inactiveDays?: number; tags?: string[] }) => {
  let score = 20;
  if (/meta|ads|referido|organic/i.test(String(source))) score += 20;
  score += Math.min(30, Math.max(0, Number(interactions || 0)) * 3);
  score -= Math.min(30, Math.max(0, Number(inactiveDays || 0)) * 2);
  if ((tags || []).some((t) => /vip|hot|inversor|urgente/i.test(String(t)))) score += 20;
  if ((tags || []).some((t) => /spam|baja|no_interesado/i.test(String(t)))) score -= 25;
  return Math.max(0, Math.min(100, Math.round(score)));
};

const normalizePhone = (value: any) => String(value || '').replace(/\D/g, '');
const normalizeEmail = (value: any) => String(value || '').trim().toLowerCase();
const parseTags = (value: any): string[] => {
  if (Array.isArray(value)) return value.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
    } catch {}
    return value.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
};

const logIntegrationError = async (args: { companyId?: number; source: 'whatsapp' | 'meta' | 'tokko'; severity?: 'low' | 'medium' | 'high'; errorCode?: string; message: string; suggestion?: string; payload?: any }) => {
  await ensureCrmFeatureTables();
  await sequelize.query(`INSERT INTO integration_errors (company_id, source, severity, error_code, message, suggestion, payload_json, created_at)
    VALUES (:companyId, :source, :severity, :errorCode, :message, :suggestion, :payloadJson, NOW())`, {
    replacements: {
      companyId: args.companyId || null,
      source: args.source,
      severity: args.severity || 'medium',
      errorCode: args.errorCode || null,
      message: args.message,
      suggestion: args.suggestion || null,
      payloadJson: JSON.stringify(args.payload || {})
    },
    type: QueryTypes.INSERT
  });
};

aiRoutes.get('/sla/overdue', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const runtime = getRuntimeSettings();
  const slaMinutes = Math.max(1, Number(req.query.slaMinutes || runtime.slaMinutes || 60));
  const shouldAutoAssign = String(req.query.autoAssign || '') === '1' || runtime.slaAutoReassign;

  const overdue: any[] = await sequelize.query(`
    SELECT t.id, t.status, t."userId", t."contactId", t."updatedAt", t."createdAt",
           EXTRACT(EPOCH FROM (NOW() - COALESCE(t."updatedAt", t."createdAt")))/60 AS elapsed_minutes
    FROM tickets t
    WHERE t."companyId" = :companyId
      AND t.status IN ('open','pending')
      AND EXTRACT(EPOCH FROM (NOW() - COALESCE(t."updatedAt", t."createdAt")))/60 > :slaMinutes
    ORDER BY elapsed_minutes DESC
    LIMIT 500`, { replacements: { companyId, slaMinutes }, type: QueryTypes.SELECT });

  let reassigned = 0;
  let suggestions = 0;
  const usersLoad: any[] = await sequelize.query(`
    SELECT t."userId" AS user_id, COUNT(*)::int AS open_count
    FROM tickets t
    WHERE t."companyId" = :companyId AND t.status IN ('open','pending') AND t."userId" IS NOT NULL
    GROUP BY t."userId"
    ORDER BY open_count ASC`, { replacements: { companyId }, type: QueryTypes.SELECT });
  const bestUserId = Number(usersLoad?.[0]?.user_id || 0) || null;

  for (const t of overdue) {
    (t as any).suggestedUserId = bestUserId;
    if (!bestUserId || Number(t.userId || 0) === bestUserId) continue;
    if (runtime.slaSuggestOnly && !shouldAutoAssign) { suggestions += 1; continue; }
    if (shouldAutoAssign) {
      await sequelize.query(`UPDATE tickets SET "userId" = :userId, "updatedAt" = NOW() WHERE id = :ticketId AND "companyId" = :companyId`, { replacements: { userId: bestUserId, ticketId: Number(t.id), companyId }, type: QueryTypes.UPDATE });
      reassigned += 1;
    }
  }

  return res.json({ slaMinutes, totalOverdue: overdue.length, reassigned, suggestions, conversations: overdue });
});

aiRoutes.get('/notes', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const entityType = String(req.query.entityType || 'conversation');
  const entityId = Number(req.query.entityId || 0);
  if (!entityId) return res.status(400).json({ error: 'entityId requerido' });
  const rows = await sequelize.query(`SELECT * FROM internal_notes WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId ORDER BY id DESC`, { replacements: { companyId, entityType, entityId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/notes', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId, id: userId } = req.user;
  const entityType = String(req.body?.entityType || 'conversation');
  const entityId = Number(req.body?.entityId || 0);
  const content = String(req.body?.content || '').trim();
  if (!entityId || !content) return res.status(400).json({ error: 'entityId y content requeridos' });
  const mentions = parseMentions(content);
  const [row]: any = await sequelize.query(`INSERT INTO internal_notes (company_id, entity_type, entity_id, content, mentions_json, created_by, created_at, updated_at)
    VALUES (:companyId, :entityType, :entityId, :content, :mentionsJson, :createdBy, NOW(), NOW()) RETURNING *`, { replacements: { companyId, entityType, entityId, content, mentionsJson: JSON.stringify(mentions), createdBy: userId }, type: QueryTypes.INSERT });
  return res.status(201).json(row);
});

aiRoutes.put('/notes/:id', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const id = Number(req.params.id || 0);
  const content = String(req.body?.content || '').trim();
  if (!id || !content) return res.status(400).json({ error: 'id y content requeridos' });
  const mentions = parseMentions(content);
  await sequelize.query(`UPDATE internal_notes SET content = :content, mentions_json = :mentionsJson, updated_at = NOW() WHERE id = :id AND company_id = :companyId`, { replacements: { id, companyId, content, mentionsJson: JSON.stringify(mentions) }, type: QueryTypes.UPDATE });
  const [row]: any = await sequelize.query(`SELECT * FROM internal_notes WHERE id = :id AND company_id = :companyId`, { replacements: { id, companyId }, type: QueryTypes.SELECT });
  return res.json(row || null);
});

aiRoutes.delete('/notes/:id', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const id = Number(req.params.id || 0);
  await sequelize.query(`DELETE FROM internal_notes WHERE id = :id AND company_id = :companyId`, { replacements: { id, companyId }, type: QueryTypes.DELETE });
  return res.json({ ok: true, deletedId: id });
});

aiRoutes.post('/templates/preview', isAuth, async (req: any, res) => {
  const template = String(req.body?.template || req.body?.content || '');
  const variables = req.body?.variables || {};
  return res.json({ rendered: renderTemplate(template, variables), missingVariables: Array.from(new Set((template.match(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g) || []).map((x) => x.replace(/[{}\s]/g, '')).filter((k) => variables?.[k] === undefined))) });
});

aiRoutes.get('/integrations/errors', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const source = String(req.query.source || '');
  const where = ['(company_id = :companyId OR company_id IS NULL)'];
  const replacements: any = { companyId };
  if (source) { where.push('source = :source'); replacements.source = source; }
  const rows = await sequelize.query(`SELECT * FROM integration_errors WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`, { replacements, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/integrations/errors/log', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const source = String(req.body?.source || '').toLowerCase() as any;
  if (!['whatsapp', 'meta', 'tokko'].includes(source)) return res.status(400).json({ error: 'source inválido' });
  await logIntegrationError({ companyId, source, severity: req.body?.severity || 'medium', errorCode: req.body?.errorCode, message: String(req.body?.message || 'integration error'), suggestion: req.body?.suggestion, payload: req.body?.payload || {} });
  return res.json({ ok: true });
});

aiRoutes.post('/leads/:contactId/recalculate-score', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId, id: userId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const [contact]: any = await sequelize.query(`SELECT id, name, email, number, tags, source, lead_score, "leadStatus" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`, { replacements: { contactId, companyId }, type: QueryTypes.SELECT });
  if (!contact) return res.status(404).json({ error: 'contacto no encontrado' });

  const interactions = Number.isFinite(Number(req.body?.interactions))
    ? Number(req.body?.interactions)
    : Number((await sequelize.query(`SELECT COUNT(*)::int AS qty FROM messages WHERE "contactId" = :contactId`, { replacements: { contactId }, type: QueryTypes.SELECT }) as any[])?.[0]?.qty || 0);
  const inactiveDays = Number.isFinite(Number(req.body?.inactiveDays))
    ? Number(req.body?.inactiveDays)
    : Number((await sequelize.query(`SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX("createdAt"), NOW()))) / 86400 AS days FROM messages WHERE "contactId" = :contactId`, { replacements: { contactId }, type: QueryTypes.SELECT }) as any[])?.[0]?.days || 0);
  const source = String(req.body?.source || contact.source || '');
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : parseTags(contact.tags);
  const newScore = scoreLead({ source, interactions, inactiveDays, tags });
  const leadStatus = newScore >= 75 ? 'hot' : newScore >= 50 ? 'warm' : newScore >= 25 ? 'engaged' : 'new';
  await sequelize.query(`UPDATE contacts SET lead_score = :leadScore, "leadStatus" = :leadStatus, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`, { replacements: { contactId, companyId, leadScore: newScore, leadStatus }, type: QueryTypes.UPDATE });
  await sequelize.query(`INSERT INTO lead_score_events (company_id, contact_id, previous_score, new_score, previous_status, new_status, reason, payload_json, created_by, created_at)
    VALUES (:companyId, :contactId, :previousScore, :newScore, :previousStatus, :newStatus, :reason, :payloadJson, :createdBy, NOW())`, {
    replacements: {
      companyId,
      contactId,
      previousScore: Number(contact.lead_score || 0),
      newScore,
      previousStatus: String(contact.leadStatus || contact.lead_status || 'new'),
      newStatus: leadStatus,
      reason: String(req.body?.reason || 'recalculate'),
      payloadJson: JSON.stringify({ source, interactions, inactiveDays, tags }),
      createdBy: userId || null
    },
    type: QueryTypes.INSERT
  });
  return res.json({ ok: true, contactId, leadScore: newScore, leadStatus, inputs: { source, interactions, inactiveDays, tags } });
});

aiRoutes.get('/leads/:contactId/score-history', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const rows = await sequelize.query(`SELECT id, previous_score, new_score, previous_status, new_status, reason, payload_json, created_by, created_at
    FROM lead_score_events WHERE company_id = :companyId AND contact_id = :contactId ORDER BY id DESC LIMIT 100`, {
    replacements: { companyId, contactId },
    type: QueryTypes.SELECT
  });
  return res.json(rows);
});

aiRoutes.get('/routing/rules', isAuth, async (_req: any, res) => {
  const runtime = getRuntimeSettings();
  let rules: any[] = [];
  try { rules = JSON.parse(runtime.routingRulesJson || '[]'); } catch {}
  return res.json({ rules });
});

aiRoutes.put('/routing/rules', isAuth, isAdmin, async (req: any, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const next = saveRuntimeSettings({ routingRulesJson: JSON.stringify(rules) });
  return res.json({ ok: true, rules: JSON.parse(next.routingRulesJson || '[]') });
});

aiRoutes.post('/routing/resolve', isAuth, async (req: any, res) => {
  const runtime = getRuntimeSettings();
  let rules: any[] = [];
  try { rules = JSON.parse(runtime.routingRulesJson || '[]'); } catch {}
  const source = String(req.body?.source || '').toLowerCase();
  const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).map((t: any) => String(t).toLowerCase());
  const channel = String(req.body?.channel || '').toLowerCase();
  const priority = Number(req.body?.priority || 0);
  const match = rules.find((r: any) => {
    if (r?.enabled === false) return false;
    if (r?.source && String(r.source).toLowerCase() !== source) return false;
    if (r?.channel && String(r.channel).toLowerCase() !== channel) return false;
    if (Number.isFinite(Number(r?.priorityMin)) && priority < Number(r.priorityMin)) return false;
    if (Array.isArray(r?.tagsAny) && r.tagsAny.length && !r.tagsAny.some((x: string) => tags.includes(String(x).toLowerCase()))) return false;
    return true;
  }) || null;
  return res.json({ matched: match, assignedUserId: match?.assignUserId || null, routingKey: match?.key || null });
});

aiRoutes.post('/routing/execute', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const contactId = Number(req.body?.contactId || 0);
  if (!contactId) return res.status(400).json({ error: 'contactId requerido' });

  const runtime = getRuntimeSettings();
  let rules: any[] = [];
  try { rules = JSON.parse(runtime.routingRulesJson || '[]'); } catch {}
  const source = String(req.body?.source || '').toLowerCase();
  const tags = (Array.isArray(req.body?.tags) ? req.body.tags : []).map((t: any) => String(t).toLowerCase());
  const channel = String(req.body?.channel || '').toLowerCase();
  const priority = Number(req.body?.priority || 0);
  const dryRun = String(req.body?.dryRun || '') === '1';

  const match = rules.find((r: any) => {
    if (r?.enabled === false) return false;
    if (r?.source && String(r.source).toLowerCase() !== source) return false;
    if (r?.channel && String(r.channel).toLowerCase() !== channel) return false;
    if (Number.isFinite(Number(r?.priorityMin)) && priority < Number(r.priorityMin)) return false;
    if (Array.isArray(r?.tagsAny) && r.tagsAny.length && !r.tagsAny.some((x: string) => tags.includes(String(x).toLowerCase()))) return false;
    return true;
  }) || null;

  if (!match) return res.json({ ok: true, applied: false, reason: 'no_rule_match' });
  if (dryRun) return res.json({ ok: true, applied: false, dryRun: true, matched: match, assignUserId: match?.assignUserId || null });

  await sequelize.query(`UPDATE contacts SET "assignedUserId" = COALESCE(:assignedUserId, "assignedUserId"), "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`, {
    replacements: { assignedUserId: Number(match?.assignUserId || 0) || null, contactId, companyId },
    type: QueryTypes.UPDATE
  });

  return res.json({ ok: true, applied: true, contactId, matched: match, assignUserId: match?.assignUserId || null });
});

aiRoutes.post('/leads/:contactId/close', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const status = String(req.body?.status || 'lost').toLowerCase();
  const normalizedStatus = status === 'perdido' ? 'lost' : status;
  const validStatus = ['lost', 'won', 'read', 'engaged', 'warm', 'hot', 'new'];
  if (!validStatus.includes(normalizedStatus)) return res.status(400).json({ error: 'status inválido' });
  const lossReason = String(req.body?.lossReason || '').trim();
  if (normalizedStatus === 'lost' && !lossReason) return res.status(400).json({ error: 'lossReason obligatorio para lead perdido' });

  const [contact]: any = await sequelize.query(`SELECT id, needs FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`, { replacements: { contactId, companyId }, type: QueryTypes.SELECT });
  if (!contact) return res.status(404).json({ error: 'contacto no encontrado' });
  const mergedNeeds = [String(contact.needs || ''), lossReason ? `\n[LOSS_REASON] ${lossReason}` : ''].join('').slice(0, 900);
  await sequelize.query(`UPDATE contacts SET "leadStatus" = :leadStatus, needs = :needs, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`, {
    replacements: { contactId, companyId, leadStatus: normalizedStatus === 'won' ? 'customer' : normalizedStatus, needs: mergedNeeds },
    type: QueryTypes.UPDATE
  });
  return res.json({ ok: true, contactId, status: normalizedStatus, lossReason: lossReason || null });
});

const updateLeadStatusHandler = async (req: any, res: any) => {
  const { companyId } = req.user;
  const contactId = Number(req.params.contactId || 0);
  const status = String(req.body?.status || 'lost').toLowerCase();
  const normalizedStatus = status === 'perdido' ? 'lost' : status;
  const validStatus = ['lost', 'won', 'read', 'engaged', 'warm', 'hot', 'new'];
  if (!validStatus.includes(normalizedStatus)) return res.status(400).json({ error: 'status inválido' });
  const lossReason = String(req.body?.lossReason || '').trim();
  if (normalizedStatus === 'lost' && !lossReason) return res.status(400).json({ error: 'lossReason obligatorio para lead perdido' });

  const [contact]: any = await sequelize.query(`SELECT id, needs FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`, { replacements: { contactId, companyId }, type: QueryTypes.SELECT });
  if (!contact) return res.status(404).json({ error: 'contacto no encontrado' });
  const mergedNeeds = [String(contact.needs || ''), lossReason ? `\n[LOSS_REASON] ${lossReason}` : ''].join('').slice(0, 900);
  await sequelize.query(`UPDATE contacts SET "leadStatus" = :leadStatus, needs = :needs, "updatedAt" = NOW() WHERE id = :contactId AND "companyId" = :companyId`, {
    replacements: { contactId, companyId, leadStatus: normalizedStatus === 'won' ? 'customer' : normalizedStatus, needs: mergedNeeds },
    type: QueryTypes.UPDATE
  });
  return res.json({ ok: true, contactId, status: normalizedStatus, lossReason: lossReason || null });
};

aiRoutes.post('/leads/:contactId/status', isAuth, updateLeadStatusHandler);
aiRoutes.put('/contacts/:contactId/status', isAuth, updateLeadStatusHandler);

aiRoutes.post('/followups/schedule', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const contactId = Number(req.body?.contactId || 0) || null;
  if (!contactId) return res.status(400).json({ error: 'contactId requerido' });
  const runtime = getRuntimeSettings();
  let days = [1, 3, 7];
  try { days = (JSON.parse(runtime.followUpDaysJson || '[1,3,7]') || []).map((x: any) => Number(x)).filter((x: number) => x > 0); } catch {}
  const baseDate = req.body?.baseDate ? new Date(req.body.baseDate) : new Date();
  const sequenceGroup = String(req.body?.sequenceGroup || `${companyId}:conversation:${contactId || 0}:${baseDate.toISOString().slice(0, 10)}`);
  const idempotencyPrefix = String(req.body?.idempotencyKey || `${sequenceGroup}`);
  const created: any[] = [];
  const skipped: any[] = [];
  for (const day of days) {
    const scheduledAt = new Date(baseDate.getTime() + day * 24 * 60 * 60 * 1000);
    const idempotencyKey = `${idempotencyPrefix}:D+${day}`;
    const existing: any[] = await sequelize.query(`SELECT * FROM followup_sequences WHERE company_id = :companyId AND idempotency_key = :idempotencyKey LIMIT 1`, {
      replacements: { companyId, idempotencyKey },
      type: QueryTypes.SELECT
    });
    if (existing[0]) { skipped.push(existing[0]); continue; }
    const [row]: any = await sequelize.query(`INSERT INTO followup_sequences (company_id, ticket_id, contact_id, day_offset, template_text, status, scheduled_at, idempotency_key, sequence_group, created_at)
      VALUES (:companyId, :ticketId, :contactId, :dayOffset, :templateText, 'scheduled', :scheduledAt, :idempotencyKey, :sequenceGroup, NOW()) RETURNING *`, {
      replacements: { companyId, ticketId: null, contactId, dayOffset: day, templateText: `Seguimiento D+${day}` , scheduledAt, idempotencyKey, sequenceGroup },
      type: QueryTypes.INSERT
    });
    created.push(row);
  }
  return res.json({ ok: true, scheduled: created.length, skipped: skipped.length, sequenceGroup, items: created, existing: skipped });
});

aiRoutes.post('/followups/run-due', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const dryRun = String(req.body?.dryRun || '') === '1';
  const due: any[] = await sequelize.query(`SELECT * FROM followup_sequences WHERE company_id = :companyId AND status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 200`, { replacements: { companyId }, type: QueryTypes.SELECT });
  let executed = 0;
  if (!dryRun) {
    for (const row of due) {
      const [updated]: any = await sequelize.query(`UPDATE followup_sequences SET status = 'executed', executed_at = NOW() WHERE id = :id AND company_id = :companyId AND status = 'scheduled' RETURNING id`, { replacements: { id: Number(row.id), companyId }, type: QueryTypes.UPDATE });
      if (updated?.id) executed += 1;
    }
  }
  return res.json({ ok: true, dryRun, due: due.length, executed: dryRun ? 0 : executed, items: due });
});

aiRoutes.get('/followups', isAuth, async (req: any, res) => {
  await ensureCrmFeatureTables();
  const { companyId } = req.user;
  const rows = await sequelize.query(`SELECT * FROM followup_sequences WHERE company_id = :companyId ORDER BY id DESC LIMIT 500`, { replacements: { companyId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

// Aliases for compatibility with UIs calling /sequences
aiRoutes.post('/sequences/schedule', isAuth, async (req: any, res) => {
  req.url = '/followups/schedule';
  return (aiRoutes as any).handle(req, res);
});
aiRoutes.post('/sequences/run-due', isAuth, async (req: any, res) => {
  req.url = '/followups/run-due';
  return (aiRoutes as any).handle(req, res);
});
aiRoutes.get('/sequences', isAuth, async (req: any, res) => {
  req.url = '/followups';
  return (aiRoutes as any).handle(req, res);
});

aiRoutes.get('/dedupe/candidates', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const rows = await sequelize.query(`
    WITH by_phone AS (
      SELECT 'phone'::text AS dedupe_key_type,
             REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g') AS dedupe_key,
             ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
             COUNT(*)::int AS qty
      FROM contacts c
      WHERE c."companyId" = :companyId
        AND REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g') <> ''
      GROUP BY REGEXP_REPLACE(COALESCE(c.number,''), '\\D', '', 'g')
      HAVING COUNT(*) > 1
    ),
    by_email AS (
      SELECT 'email'::text AS dedupe_key_type,
             LOWER(TRIM(COALESCE(c.email,''))) AS dedupe_key,
             ARRAY_AGG(c.id ORDER BY c.id) AS contact_ids,
             COUNT(*)::int AS qty
      FROM contacts c
      WHERE c."companyId" = :companyId
        AND LOWER(TRIM(COALESCE(c.email,''))) <> ''
      GROUP BY LOWER(TRIM(COALESCE(c.email,'')))
      HAVING COUNT(*) > 1
    )
    SELECT dedupe_key_type, dedupe_key, contact_ids, qty, (contact_ids[1]) AS primary_contact_id
    FROM (
      SELECT * FROM by_phone
      UNION ALL
      SELECT * FROM by_email
    ) z
    ORDER BY qty DESC, dedupe_key_type ASC
    LIMIT 200`, { replacements: { companyId }, type: QueryTypes.SELECT });
  return res.json(rows);
});

aiRoutes.post('/dedupe/merge', isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const primaryContactId = Number(req.body?.primaryContactId || 0);
  const secondaryContactId = Number(req.body?.secondaryContactId || 0);
  const force = String(req.body?.force || '') === '1';
  if (!primaryContactId || !secondaryContactId || primaryContactId === secondaryContactId) return res.status(400).json({ error: 'primaryContactId y secondaryContactId válidos son requeridos' });

  const runtime = getRuntimeSettings();
  const [primary]: any = await sequelize.query(`SELECT * FROM contacts WHERE id = :id AND "companyId" = :companyId LIMIT 1`, { replacements: { id: primaryContactId, companyId }, type: QueryTypes.SELECT });
  const [secondary]: any = await sequelize.query(`SELECT * FROM contacts WHERE id = :id AND "companyId" = :companyId LIMIT 1`, { replacements: { id: secondaryContactId, companyId }, type: QueryTypes.SELECT });
  if (!primary || !secondary) return res.status(404).json({ error: 'contacto no encontrado' });

  const samePhone = normalizePhone(primary.number) && normalizePhone(primary.number) === normalizePhone(secondary.number);
  const sameEmail = normalizeEmail(primary.email) && normalizeEmail(primary.email) === normalizeEmail(secondary.email);
  const hasMatch = samePhone || sameEmail;
  if (!hasMatch && !force) return res.status(422).json({ error: 'merge bloqueado: contactos sin key dedupe común (usar force=1 para override)' });
  if (runtime.dedupeStrictEmail && !sameEmail && !force) return res.status(422).json({ error: 'merge bloqueado por dedupeStrictEmail: emails no coinciden' });

  const tx = await sequelize.transaction();
  try {
    await sequelize.query(`UPDATE tickets SET "contactId" = :primaryId WHERE "contactId" = :secondaryId AND "companyId" = :companyId`, { replacements: { primaryId: primaryContactId, secondaryId: secondaryContactId, companyId }, type: QueryTypes.UPDATE, transaction: tx });
    await sequelize.query(`UPDATE messages SET "contactId" = :primaryId WHERE "contactId" = :secondaryId`, { replacements: { primaryId: primaryContactId, secondaryId: secondaryContactId }, type: QueryTypes.UPDATE, transaction: tx });
    await sequelize.query(`INSERT INTO contact_tags ("contactId", "tagId", "createdAt", "updatedAt")
      SELECT :primaryId, ct."tagId", NOW(), NOW() FROM contact_tags ct WHERE ct."contactId" = :secondaryId
      ON CONFLICT ("contactId", "tagId") DO NOTHING`, { replacements: { primaryId: primaryContactId, secondaryId: secondaryContactId }, type: QueryTypes.INSERT, transaction: tx });

    const mergedName = String(primary.name || secondary.name || '');
    const mergedEmail = String(primary.email || secondary.email || '');
    const mergedNumber = String(primary.number || secondary.number || '');
    const mergedNeeds = [String(primary.needs || ''), String(secondary.needs || '')].filter(Boolean).join('\n').slice(0, 900);
    const mergedLeadScore = Math.max(Number(primary.lead_score || 0), Number(secondary.lead_score || 0));
    await sequelize.query(`UPDATE contacts SET name = :name, email = :email, number = :number, needs = :needs, lead_score = :leadScore, "updatedAt" = NOW() WHERE id = :id AND "companyId" = :companyId`, { replacements: { id: primaryContactId, companyId, name: mergedName, email: mergedEmail, number: mergedNumber, needs: mergedNeeds, leadScore: mergedLeadScore }, type: QueryTypes.UPDATE, transaction: tx });
    await sequelize.query(`DELETE FROM contacts WHERE id = :id AND "companyId" = :companyId`, { replacements: { id: secondaryContactId, companyId }, type: QueryTypes.DELETE, transaction: tx });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return res.json({ ok: true, primaryContactId, mergedFrom: secondaryContactId, matchedBy: { samePhone, sameEmail }, forced: force });
});



aiRoutes.get('/link-preview', isAuth, async (req: any, res: any) => {
  const rawUrl = String(req.query?.url || '').trim();
  if (!/^https?:\/\//i.test(rawUrl)) return res.status(400).json({ error: 'url inválida' });

  try {
    const u = new URL(rawUrl);
    const host = String(u.hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
      return res.status(400).json({ error: 'host no permitido' });
    }

    const r = await fetch(rawUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CharlottCRM/1.0; +https://login.charlott.ai)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    const html = String(await r.text().catch(() => '')).slice(0, 250000);

    const pickMeta = (name: string) => {
      const p1 = new RegExp(`<meta[^>]+(?:property|name)=\"${name}\"[^>]+content=\"([^\"]+)\"`, 'i');
      const p2 = new RegExp(`<meta[^>]+content=\"([^\"]+)\"[^>]+(?:property|name)=\"${name}\"`, 'i');
      const p3 = new RegExp(`<meta[^>]+(?:property|name)='${name}'[^>]+content='([^']+)'`, 'i');
      const p4 = new RegExp(`<meta[^>]+content='([^']+)'[^>]+(?:property|name)='${name}'`, 'i');
      const m = html.match(p1) || html.match(p2) || html.match(p3) || html.match(p4);
      return String(m?.[1] || '').trim();
    };

    const titleTag = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim();
    const title = pickMeta('og:title') || pickMeta('twitter:title') || titleTag || u.hostname;
    const description = pickMeta('og:description') || pickMeta('description') || pickMeta('twitter:description');
    const image = pickMeta('og:image') || pickMeta('twitter:image');

    const abs = (v: string) => {
      if (!v) return '';
      try { return new URL(v, rawUrl).toString(); } catch { return ''; }
    };

    return res.json({
      ok: true,
      url: rawUrl,
      host: u.hostname,
      title: title.slice(0, 180),
      description: String(description || '').slice(0, 240),
      image: abs(image)
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || 'link_preview_failed') });
  }
});

export default aiRoutes;


