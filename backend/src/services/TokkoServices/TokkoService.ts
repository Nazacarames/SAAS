import { QueryTypes } from "sequelize";
import sequelize from "../../database";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";

const safeJson = async (res: Response) => {
  try { return await res.json(); } catch { return null; }
};

const buildUrl = (baseUrl: string, p: string, key: string, params: Record<string, any> = {}) => {
  const cleanBase = String(baseUrl || "https://tokkobroker.com/api/v1").replace(/\/$/, "");
  const rawPath = String(p || "");
  const cleanPath = rawPath.startsWith("/") ? rawPath : ("/" + rawPath);
  const u = new URL(cleanBase + cleanPath);
  u.searchParams.set("key", key);
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    u.searchParams.set(k, String(v));
  });
  return u.toString();
};

const OP_MAP: Record<string, number> = {
  venta: 1, comprar: 1, compra: 1,
  alquiler: 2, alquilar: 2, renta: 2,
  temporal: 3
};

const TYPE_MAP: Record<string, number> = {
  lote: 1, terreno: 1,
  departamento: 2, depto: 2,
  casa: 3,
  local: 5,
  oficina: 7
};

const normalizePhone = (raw?: string) => String(raw || "").replace(/\s+/g, "").trim();
const validEmail = (raw?: string) => /^\S+@\S+\.\S+$/.test(String(raw || "").trim());

const withRetry429 = async (fn: () => Promise<Response>, max = 3): Promise<Response> => {
  let delay = 400;
  let lastRes: Response | null = null;
  for (let i = 0; i < max; i++) {
    lastRes = await fn();
    if (lastRes.status !== 429 || i === max - 1) return lastRes;
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
  return lastRes!;
};

export const fetchTokkoLocations = async () => {
  const s = getRuntimeSettings();
  if (!s.tokkoEnabled || !s.tokkoApiKey) return { ok: false, skipped: true };

  const url = buildUrl(s.tokkoBaseUrl, "/location/", s.tokkoApiKey, { lang: "es" });
  const res = await withRetry429(() => fetch(url, { method: "GET" }));
  const data: any = await safeJson(res);
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  return { ok: res.ok, status: res.status, objects, raw: data };
};

const flattenLocations = (nodes: any[], out: Array<{ id: number; name: string; full: string; type: string }> = []) => {
  for (const n of nodes || []) {
    const id = Number(n?.id || 0);
    const name = String(n?.name || "").trim();
    const full = String(n?.full_location || n?.full || name).trim();
    const type = String(n?.type || n?.location_type || "division").trim();
    if (id && name) out.push({ id, name, full, type });
    const children = Array.isArray(n?.children) ? n.children : Array.isArray(n?.locations) ? n.locations : [];
    if (children.length) flattenLocations(children, out);
  }
  return out;
};

const resolveLocation = async (query?: string) => {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  const loc = await fetchTokkoLocations();
  if (!loc.ok) return null;
  const flat = flattenLocations(loc.objects || []);
  const exact = flat.find((x) => x.name.toLowerCase() === q || x.full.toLowerCase() === q);
  if (exact) return exact;
  return flat.find((x) => x.name.toLowerCase().includes(q) || x.full.toLowerCase().includes(q)) || null;
};

export const syncLeadToTokko = async (lead: { name?: string; phone?: string; email?: string; message?: string; source?: string; propertyId?: number; tags?: string[] }) => {
  const s = getRuntimeSettings();
  if (!s.tokkoEnabled || !s.tokkoApiKey) return { ok: false, skipped: true, reason: "tokko_disabled_or_missing_key" };

  const url = buildUrl(s.tokkoBaseUrl, s.tokkoLeadsPath || "/webcontact/", s.tokkoApiKey);
  const payload: any = {
    name: lead.name || "Lead Charlott",
    email: validEmail(lead.email) ? String(lead.email) : "",
    phone: normalizePhone(lead.phone),
    text: lead.message || "Nuevo lead ingresado desde Charlott CRM",
    source: lead.source || "OpenClaw AI Bot",
    tags: Array.isArray(lead.tags) && lead.tags.length ? lead.tags : ["Lead_Calificado", "Bot"]
  };
  if (lead.propertyId) payload.properties = [Number(lead.propertyId)];

  const res = await withRetry429(() => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
  const data = await safeJson(res);
  return { ok: res.ok, status: res.status, data, url, payload };
};

export const searchTokkoProperties = async (args: { q?: string; operationType?: string; propertyType?: string; location?: string; minPrice?: number; maxPrice?: number; minBedrooms?: number; limit?: number; offset?: number; currency?: string }) => {
  const s = getRuntimeSettings();
  if (!s.tokkoEnabled || !s.tokkoApiKey) return { ok: false, skipped: true, reason: "tokko_disabled_or_missing_key" };

  const limit = Math.max(1, Math.min(50, Number(args.limit || 20)));
  const offset = Math.max(0, Number(args.offset || 0));
  const op = OP_MAP[String(args.operationType || "").toLowerCase()] || 1;
  const pType = TYPE_MAP[String(args.propertyType || "").toLowerCase()] || undefined;
  const loc = await resolveLocation(args.location);

  const filters: any[] = [];
  if (Number(args.minBedrooms || 0) > 0) filters.push(["room_amount", ">=", Number(args.minBedrooms)]);

  const dataPayload: any = {
    current_localization_id: Number(loc?.id || 0),
    current_localization_type: String(loc?.type || "country"),
    price_from: Number(args.minPrice || 0),
    price_to: Number(args.maxPrice || 999999999),
    operation_types: [op],
    property_types: pType ? [pType] : [1, 2, 3, 5, 7],
    currency: args.currency || "ANY",
    filters,
    limit,
    offset
  };

  const postUrl = buildUrl(s.tokkoBaseUrl, "/property/search/", s.tokkoApiKey);
  let res = await withRetry429(() => fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dataPayload)
  }));

  // Tokko accounts that do not allow POST search require GET with data=<json>
  if (res.status === 405 || res.status === 400) {
    const getUrl = buildUrl(s.tokkoBaseUrl, "/property/search/", s.tokkoApiKey, { data: JSON.stringify(dataPayload) });
    res = await withRetry429(() => fetch(getUrl, { method: "GET" }));
  }

  const parsed: any = await safeJson(res);
  const objects = Array.isArray(parsed?.objects) ? parsed.objects : [];
  const mapped = objects.map((p: any) => ({
    id: p?.id,
    code: p?.code,
    title: p?.publication_title || p?.title || p?.address || "Propiedad",
    price: p?.price || p?.operations?.[0]?.prices?.[0]?.price || null,
    currency: p?.operations?.[0]?.prices?.[0]?.currency || null,
    location: p?.location?.full_location || p?.location?.name || p?.real_address || "",
    type: p?.type?.name || p?.property_type?.name || "",
    operation: p?.operations?.[0]?.operation_type?.type || "",
    url: p?.url || p?.public_url || "",
    imageUrl: p?.photos?.[0]?.image || p?.photos?.[0]?.url || p?.cover?.url || ""
  }));

  return {
    ok: res.ok,
    status: res.status,
    total: Number(parsed?.meta?.total_count || mapped.length),
    limit: Number(parsed?.meta?.limit || limit),
    offset: Number(parsed?.meta?.offset || offset),
    results: mapped,
    raw: parsed
  };
};

const chunkText = (text: string, maxLen = 900) => {
  const out: string[] = [];
  let rest = String(text || "").trim();
  while (rest.length > maxLen) {
    out.push(rest.slice(0, maxLen));
    rest = rest.slice(maxLen);
  }
  if (rest) out.push(rest);
  return out;
};

export const syncTokkoLocationsToKnowledge = async (companyId = 1) => {
  const loc = await fetchTokkoLocations();
  if (!loc.ok) return { ok: false, status: (loc as any).status || 500, error: "tokko_location_fetch_failed" };

  const flat = flattenLocations(loc.objects || []);
  const uniq = Array.from(new Map(flat.map((x) => [x.full.toLowerCase(), x.full])).values()).sort((a, b) => a.localeCompare(b, "es"));

  const header = "Zonas disponibles:";
  const body = uniq.map((l) => `- ${l}`).join("\n");
  const content = `${header}\n${body}`.slice(0, 50000);

  const [existing]: any[] = await sequelize.query(
    `SELECT id FROM kb_documents
     WHERE company_id = :companyId AND source_type = 'tokko_locations'
     ORDER BY id DESC LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  let documentId = Number(existing?.id || 0);
  if (!documentId) {
    const inserted: any = await sequelize.query(
      `INSERT INTO kb_documents (company_id, title, category, source_type, status, content, created_at, updated_at)
       VALUES (:companyId, :title, :category, 'tokko_locations', 'ready', :content, NOW(), NOW())
       RETURNING id`,
      { replacements: { companyId, title: "Ubicaciones Tokko", category: "tokko", content }, type: QueryTypes.INSERT }
    );
    documentId = Number((inserted as any)?.[0]?.id || (inserted as any)?.[0]?.[0]?.id || 0);
  } else {
    await sequelize.query(
      `UPDATE kb_documents
       SET title = :title, category = :category, status = 'ready', content = :content, updated_at = NOW()
       WHERE id = :documentId`,
      { replacements: { documentId, title: "Ubicaciones Tokko", category: "tokko", content }, type: QueryTypes.UPDATE }
    );
    await sequelize.query(`DELETE FROM kb_chunks WHERE document_id = :documentId`, { replacements: { documentId }, type: QueryTypes.DELETE });
  }

  const chunks = chunkText(content, 900);
  for (let i = 0; i < chunks.length; i++) {
    await sequelize.query(
      `INSERT INTO kb_chunks (document_id, chunk_index, chunk_text, token_count, embedding_json, created_at, updated_at)
       VALUES (:documentId, :chunkIndex, :chunkText, :tokenCount, :embeddingJson, NOW(), NOW())`,
      {
        replacements: {
          documentId,
          chunkIndex: i,
          chunkText: chunks[i],
          tokenCount: Math.max(1, Math.ceil(chunks[i].length / 4)),
          embeddingJson: null
        },
        type: QueryTypes.INSERT
      }
    );
  }

  return { ok: true, status: Number((loc as any).status || 200), locations: uniq.length, documentId, chunks: chunks.length };
};
