import { getWbot } from "../../libs/wbot";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import AppError from "../../errors/AppError";
import { getIO } from "../../libs/socket";
import crypto from "crypto";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";
import sequelize from "../../database";
import { QueryTypes } from "sequelize";

let outboundDedupeTableReady = false;
let outboundDedupeLastPruneAt = 0;
const OUTBOUND_DEDUPE_TTL_SECONDS = 120;
const OUTBOUND_DEDUPE_PRUNE_INTERVAL_MS = 60 * 1000;
const emergencyOutboundDedupe = new Map<string, number>();
const resolveOutboundRetryWindowFloorSeconds = (): number => {
  const settings = getRuntimeSettings() as any;
  const maxAttempts = Math.max(1, Math.min(6, Number(settings.waOutboundRetryMaxAttempts || 3)));
  const timeoutMs = Math.max(1000, Math.min(45000, Math.round(Number(settings.waOutboundRequestTimeoutMs || 12000))));
  const maxDelayMs = Math.max(500, Math.min(60000, Math.round(Number(settings.waOutboundRetryMaxDelayMs || 15000))));

  // keep dedupe reservation alive across full retry window (+ small post-send race buffer)
  const floorMs = (maxAttempts * (timeoutMs + maxDelayMs)) + 30_000;
  return Math.max(60, Math.ceil(floorMs / 1000));
};

const resolveOutboundDedupeTtlSeconds = () => {
  const configured = Number((getRuntimeSettings() as any).waOutboundDedupeTtlSeconds || OUTBOUND_DEDUPE_TTL_SECONDS);
  const configuredSafe = Number.isFinite(configured) ? Math.round(configured) : OUTBOUND_DEDUPE_TTL_SECONDS;
  const retryWindowFloor = resolveOutboundRetryWindowFloorSeconds();
  const effective = Math.max(configuredSafe, retryWindowFloor);
  return Math.max(30, Math.min(900, effective));
};

const resolveOutboundDedupeFailClosed = (): boolean => {
  const raw = (getRuntimeSettings() as any).waOutboundDedupeFailClosed;
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return true; // secure default
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
};

const resolveOutboundDedupeMemoryMaxEntries = (): number => {
  const n = Number((getRuntimeSettings() as any).waOutboundDedupeMemoryMaxEntries || 5000);
  if (!Number.isFinite(n)) return 5000;
  return Math.max(100, Math.min(50000, Math.round(n)));
};

const HARDENING_ALERT_WINDOW_MS = 10 * 60 * 1000;
const hardeningSignalBuckets = new Map<string, number[]>();
const hardeningMetricCounters = new Map<string, number>();
const hardeningMetricLastAt = new Map<string, string>();

const bumpHardeningMetric = (metric: string, by = 1) => {
  const next = (hardeningMetricCounters.get(metric) || 0) + by;
  hardeningMetricCounters.set(metric, next);
  hardeningMetricLastAt.set(metric, new Date().toISOString());
};

const bumpOutboundModeMetric = (metricPrefix: string, mode: OutboundMode, by = 1) => {
  bumpHardeningMetric(`${metricPrefix}.${mode}`, by);
};

export const getSendHardeningMetrics = () => ({
  counters: Object.fromEntries(Array.from(hardeningMetricCounters.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
  lastSeenAt: Object.fromEntries(Array.from(hardeningMetricLastAt.entries()).sort((a, b) => a[0].localeCompare(b[0])))
});

export const getSendHardeningAlertSnapshot = () => {
  const now = Date.now();
  const pendingAlerts = Array.from(hardeningSignalBuckets.entries())
    .map(([signal, hits]) => ({
      signal,
      count: hits.filter((ts) => now - ts < HARDENING_ALERT_WINDOW_MS).length
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal));

  return {
    windowMs: HARDENING_ALERT_WINDOW_MS,
    pendingAlerts
  };
};

const pushHardeningSignal = (signal: string, threshold: number, context?: Record<string, unknown>) => {
  bumpHardeningMetric(`signal.${signal}`);
  const now = Date.now();
  const prev = hardeningSignalBuckets.get(signal) || [];
  const next = prev.filter((ts) => now - ts < HARDENING_ALERT_WINDOW_MS);
  next.push(now);
  hardeningSignalBuckets.set(signal, next);

  if (next.length >= threshold) {
    bumpHardeningMetric(`alert.${signal}`);
    console.warn("[wa-hardening][alert] threshold reached", {
      signal,
      count: next.length,
      windowMs: HARDENING_ALERT_WINDOW_MS,
      ...context
    });
    hardeningSignalBuckets.set(signal, []);
  }
};

const normalizeForDedupe = (text: string) => {
  const raw = String(text || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars often used to bypass dedupe
    .toLowerCase();

  const folded = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // fold accents (ej: "mañana" ~= "manana")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const candidate = folded || raw.replace(/\s+/g, " ").trim();
  if (!candidate) return "";

  // keep a readable prefix but preserve entropy for long bodies to avoid collisions on common prefixes
  if (candidate.length <= 200) return candidate;
  const suffix = crypto.createHash("sha1").update(candidate).digest("hex").slice(0, 12);
  return `${candidate.slice(0, 200)}#${suffix}`;
};

const normalizeMediaUrlForDedupe = (rawUrl: string): string => {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  try {
    const u = new URL(input);
    // signed CDN links rotate query params often; dedupe by stable resource identity
    const host = u.hostname.toLowerCase();
    const path = decodeURIComponent(u.pathname || "").replace(/\/+/g, "/");
    return `${host}${path}`.slice(0, 240);
  } catch {
    // non-URL payloads (file ids, opaque refs)
    return input.split("?")[0].split("#")[0].trim().slice(0, 240);
  }
};

const normalizeTemplateLocaleForDedupe = (rawLocale: string): string => {
  const locale = String(rawLocale || "es_AR")
    .trim()
    .replace(/-/g, "_")
    .replace(/[^A-Za-z_]/g, "");
  if (!locale) return "es_AR";

  const [lang = "es", country = "AR"] = locale.split("_");
  const cleanLang = (lang || "es").toLowerCase().slice(0, 8);
  const cleanCountry = (country || "AR").toUpperCase().slice(0, 8);
  return `${cleanLang}_${cleanCountry}`;
};

const normalizeTemplateVariableForDedupe = (rawValue: unknown): string => {
  const canonical = typeof rawValue === "string"
    ? rawValue
    : stableStringify(rawValue);

  return String(canonical ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
};

type OutboundMode = "text" | "template" | "media";
type OutboundMediaType = "image" | "video" | "audio" | "document";

type OutboundPayload = {
  mode: OutboundMode;
  text?: string;
  templateName?: string;
  languageCode?: string;
  templateVariables?: string[];
  mediaUrl?: string;
  mediaType?: OutboundMediaType;
  caption?: string;
};

const OUTBOUND_IDEMPOTENCY_KEY_MAX_LENGTH = 120;

const normalizeClientIdempotencyKey = (rawKey: string): string => {
  const cleaned = String(rawKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_\-.]/g, "")
    .slice(0, OUTBOUND_IDEMPOTENCY_KEY_MAX_LENGTH);
  return cleaned;
};

const hasInvalidClientIdempotencyChars = (rawKey: string): boolean => {
  return /[^a-zA-Z0-9:_\-.]/.test(String(rawKey || ""));
};

const isMonotonicSequence = (value: string): boolean => {
  if (value.length < 6) return false;
  let direction = 0;

  for (let i = 1; i < value.length; i++) {
    const prev = value.charCodeAt(i - 1);
    const curr = value.charCodeAt(i);
    const delta = curr - prev;

    if (delta !== 1 && delta !== -1) return false;
    if (direction === 0) direction = delta;
    if (delta !== direction) return false;
  }

  return true;
};

const isTimestampOnlyIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeClientIdempotencyKey(key);
  if (!normalized) return false;
  const compact = normalized.replace(/[:_\-.]/g, "");
  return /^\d{10,17}$/.test(compact);
};

const isWeakClientIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeClientIdempotencyKey(key);
  if (!normalized) return false;

  // weak keys (e.g. "aaaaaaaa") increase collision risk across retries/outbound requests
  if (new Set(normalized).size < 2) return true;

  // strip separators to catch weak synthetic keys like "12345678" or "abcdefghi"
  const compact = normalized.replace(/[:_\-.]/g, "");
  if (isMonotonicSequence(compact)) return true;

  // raw unix timestamps are predictable and often reused in retries/concurrent workers
  if (/^\d{10,17}$/.test(compact)) return true;

  return false;
};

const stableStringify = (value: any): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const buildOutboundDedupeKey = (
  ticketId: number,
  toRaw: string,
  payload: OutboundPayload,
  clientIdempotencyKey?: string,
  tenantScopeRaw?: string
) => {
  const to = String(toRaw || "").replace(/\D/g, "");
  const tenantScope = String(tenantScopeRaw || "global").trim().toLowerCase().replace(/[^a-z0-9:_\-.]/g, "").slice(0, 80) || "global";
  const semanticPayload = payload.mode === "text"
    ? {
        mode: "text",
        text: normalizeForDedupe(String(payload.text || ""))
      }
    : payload.mode === "template"
      ? {
          mode: "template",
          templateName: String(payload.templateName || "").trim().toLowerCase(),
          languageCode: normalizeTemplateLocaleForDedupe(String(payload.languageCode || "es_AR")),
          templateVariables: Array.isArray(payload.templateVariables)
            ? payload.templateVariables.map((x) => normalizeTemplateVariableForDedupe(x)).filter(Boolean)
            : []
        }
      : {
          mode: "media",
          mediaType: String(payload.mediaType || "image").toLowerCase(),
          mediaUrl: normalizeMediaUrlForDedupe(String(payload.mediaUrl || "")),
          caption: normalizeForDedupe(String(payload.caption || ""))
        };

  const semanticHash = crypto.createHash("sha1").update(stableStringify(semanticPayload)).digest("hex");
  const normalizedClientKey = normalizeClientIdempotencyKey(String(clientIdempotencyKey || ""));
  const base = normalizedClientKey
    // client idempotency key must survive ticket re-open/recreate flows to avoid duplicate outbound retries
    ? `${tenantScope}:${to}:client:${normalizedClientKey}`
    // hardening: fallback payload dedupe is contact-scoped (not ticket-scoped) to block duplicates after ticket reopen/recreate races
    : `${tenantScope}:${to}:payload:${semanticHash}`;
  return `wa-out:${crypto.createHash("sha1").update(base).digest("hex")}`;
};

const ensureOutboundDedupeTable = async () => {
  if (outboundDedupeTableReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ai_outbound_dedupe (id SERIAL PRIMARY KEY, dedupe_key VARCHAR(220) UNIQUE NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_outbound_dedupe_key ON ai_outbound_dedupe(dedupe_key)`);
  // pruning runs frequently; keep created_at indexed to avoid table scans when dedupe grows
  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ai_outbound_dedupe_created_at ON ai_outbound_dedupe(created_at)`);
  outboundDedupeTableReady = true;
};

const pruneOutboundDedupeIfDue = async (ttlSeconds: number) => {
  const now = Date.now();
  if (now - outboundDedupeLastPruneAt < OUTBOUND_DEDUPE_PRUNE_INTERVAL_MS) return;
  outboundDedupeLastPruneAt = now;
  await sequelize.query(`DELETE FROM ai_outbound_dedupe WHERE created_at < NOW() - (:ttlSeconds::text || ' seconds')::interval`, {
    replacements: { ttlSeconds },
    type: QueryTypes.DELETE
  });
};

const reserveOutboundDedupe = async (dedupeKey: string, ttlSeconds = OUTBOUND_DEDUPE_TTL_SECONDS): Promise<boolean> => {
  await ensureOutboundDedupeTable();
  await pruneOutboundDedupeIfDue(ttlSeconds);
  const rows: any[] = await sequelize.query(
    `INSERT INTO ai_outbound_dedupe (dedupe_key, created_at)
     VALUES (:dedupeKey, NOW())
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    { replacements: { dedupeKey }, type: QueryTypes.SELECT }
  );
  return Boolean(rows[0]?.dedupe_key);
};

const releaseOutboundDedupe = async (dedupeKey: string) => {
  await sequelize.query(`DELETE FROM ai_outbound_dedupe WHERE dedupe_key = :dedupeKey`, {
    replacements: { dedupeKey },
    type: QueryTypes.DELETE
  });
};

const trimEmergencyOutboundDedupe = (maxEntries: number) => {
  if (emergencyOutboundDedupe.size <= maxEntries) return;
  const overflow = emergencyOutboundDedupe.size - maxEntries;
  let trimmed = 0;
  for (const key of emergencyOutboundDedupe.keys()) {
    emergencyOutboundDedupe.delete(key);
    trimmed += 1;
    if (trimmed >= overflow) break;
  }
  if (trimmed > 0) bumpHardeningMetric("outbound.dedupe_emergency_trimmed", trimmed);
};

const reserveOutboundDedupeEmergency = (dedupeKey: string, ttlSeconds = OUTBOUND_DEDUPE_TTL_SECONDS): boolean => {
  const now = Date.now();
  const ttlMs = Math.max(30, ttlSeconds) * 1000;

  for (const [key, expiresAt] of emergencyOutboundDedupe.entries()) {
    if (expiresAt <= now) emergencyOutboundDedupe.delete(key);
  }
  trimEmergencyOutboundDedupe(resolveOutboundDedupeMemoryMaxEntries());

  const currentExpiry = emergencyOutboundDedupe.get(dedupeKey);
  if (currentExpiry && currentExpiry > now) return false;

  emergencyOutboundDedupe.set(dedupeKey, now + ttlMs);
  trimEmergencyOutboundDedupe(resolveOutboundDedupeMemoryMaxEntries());
  return true;
};

const releaseOutboundDedupeEmergency = (dedupeKey: string): boolean => {
  return emergencyOutboundDedupe.delete(dedupeKey);
};

interface SendMessageRequest {
  body?: string;
  ticketId?: number;
  userId: number;
  contactId?: number;
  templateName?: string;
  languageCode?: string;
  templateVariables?: string[];
  mediaUrl?: string;
  mediaType?: OutboundMediaType;
  caption?: string;
  idempotencyKey?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parseRetryAfterMs = (retryAfterHeader?: string | null): number | null => {
  if (!retryAfterHeader) return null;
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);

  const dateMs = Date.parse(retryAfterHeader);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
};

const resolveOutboundRetryMaxDelayMs = (): number => {
  const n = Number(getRuntimeSettings().waOutboundRetryMaxDelayMs || 15000);
  if (!Number.isFinite(n)) return 15000;
  return Math.max(500, Math.min(60000, Math.round(n)));
};

const resolveOutboundRequestTimeoutMs = (): number => {
  const n = Number(getRuntimeSettings().waOutboundRequestTimeoutMs || 12000);
  if (!Number.isFinite(n)) return 12000;
  return Math.max(1000, Math.min(45000, Math.round(n)));
};

const resolveOutboundRetryOnTimeout = (hasClientIdempotencyKey: boolean): boolean => {
  // timeout retries are the highest duplicate-risk path; require explicit opt-in + client idempotency key
  if (!Boolean((getRuntimeSettings() as any).waOutboundRetryOnTimeout)) return false;
  return hasClientIdempotencyKey;
};

const resolveOutboundRetryRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any).waOutboundRetryRequireIdempotencyKey;
  // hardening default: retries without explicit idempotency key are duplicate-prone
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
};

const resolveOutboundAllowRetryWithoutIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any).waOutboundAllowRetryWithoutIdempotencyKey;
  // hardening default: even if retry-idempotency requirement is relaxed, keep retries blocked unless explicitly enabled
  if (raw === undefined || raw === null || String(raw).trim() === "") return false;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
};

const resolveOutboundRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any).waOutboundRequireIdempotencyKey;
  // hardening default: missing idempotency key increases duplicate risk across retries/restarts
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
};

const resolveOutboundIdempotencyKeyMinLength = (): number => {
  const raw = Number((getRuntimeSettings() as any).waOutboundIdempotencyKeyMinLength);
  // default keeps compatibility with UUID-like keys while blocking trivial/accidental short keys
  if (!Number.isFinite(raw)) return 8;
  return Math.max(4, Math.min(64, Math.round(raw)));
};

const applyRetryJitter = (ms: number, maxDelayMs: number): number => {
  if (ms <= 0) return 0;
  const multiplier = 0.9 + (Math.random() * 0.2); // ±10%
  const jittered = Math.round(ms * multiplier);
  return Math.max(200, Math.min(jittered, maxDelayMs));
};

const computeBackoffMs = (attempt: number, retryAfterMs?: number | null): number => {
  const maxDelayMs = resolveOutboundRetryMaxDelayMs();
  if (retryAfterMs && retryAfterMs > 0) {
    // cap provider hints with runtime ceiling to avoid worker starvation on extreme Retry-After values
    return applyRetryJitter(Math.min(retryAfterMs, maxDelayMs), maxDelayMs);
  }
  const base = 400 * Math.pow(2, attempt - 1); // 400, 800, 1600...
  return applyRetryJitter(base, maxDelayMs); // de-sync concurrent retries
};

const isRetryableCloudFailure = (status?: number, code?: number): boolean => {
  if (!status) return true; // network/unknown error
  // 409 can be emitted after race/conflict situations where blind retries risk duplicate outbound.
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  // WhatsApp Cloud transient codes observed in rate/throughput spikes
  if (code === 131016 || code === 131048 || code === 131056) return true;
  return false;
};

const isAmbiguousDeliveryWbotFailure = (err: any): boolean => {
  const status = Number(err?.statusCode || err?.status || 0);
  if (status === 408) return true;
  const message = String(err?.message || err || "").toLowerCase();
  return /timed?out|timeout|econnreset|socket hang up|socket/.test(message);
};

const isRetryableWbotFailure = (err: any): boolean => {
  if (isAmbiguousDeliveryWbotFailure(err)) return false;
  const status = Number(err?.statusCode || err?.status || 0);
  if (status && isRetryableCloudFailure(status)) return true;
  const message = String(err?.message || err || "").toLowerCase();
  return /econnrefused|temporar|rate limit|too many requests|disconnected|not connected/.test(message);
};

const shouldReleaseDedupeAfterProviderFailure = (err: any): boolean => {
  const status = Number(err?.statusCode || err?.status || 0);
  if (!status) return false; // unknown/network errors are ambiguous: keep dedupe to prevent duplicates
  if (status === 408 || status === 409 || status === 429) return false;
  if (status >= 500) return false;
  return status >= 400 && status < 500;
};

const sendViaWbot = async (
  wbot: any,
  toRaw: string,
  payload: OutboundPayload,
  hasClientIdempotencyKey = false
): Promise<string> => {
  if (payload.mode !== "text") {
    throw new AppError("Template/media requiere canal WhatsApp Cloud", 400);
  }

  const contactNumber = `${String(toRaw || "").replace(/\D/g, "")}@s.whatsapp.net`;
  const text = String(payload.text || "");
  const maxAttempts = Math.max(1, Math.min(6, Number(getRuntimeSettings().waOutboundRetryMaxAttempts || 3)));
  const allowRetryWithoutIdempotency = resolveOutboundAllowRetryWithoutIdempotencyKey();
  const allowRetry = hasClientIdempotencyKey || (!resolveOutboundRetryRequireIdempotencyKey() && allowRetryWithoutIdempotency);
  const effectiveMaxAttempts = allowRetry ? maxAttempts : 1;

  if (!hasClientIdempotencyKey && maxAttempts > 1 && !allowRetry) {
    bumpHardeningMetric("outbound.wbot_retry_blocked_without_idempotency_policy");
    pushHardeningSignal("outbound_wbot_retry_blocked_without_idempotency_policy", 3, {
      maxAttempts,
      retryRequireIdempotencyKey: resolveOutboundRetryRequireIdempotencyKey(),
      allowRetryWithoutIdempotency
    });
  }
  let lastErr: any;

  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
    try {
      const sentMessage: any = await wbot.sendMessage(contactNumber, { text });
      bumpHardeningMetric("outbound.wbot_send_ok");
      return sentMessage?.key?.id || `wbot-${Date.now()}`;
    } catch (err: any) {
      lastErr = err;
      const ambiguousDelivery = isAmbiguousDeliveryWbotFailure(err);
      const retryable = isRetryableWbotFailure(err);

      if (ambiguousDelivery) {
        bumpHardeningMetric("outbound.wbot_retry_blocked_ambiguous_delivery");
        pushHardeningSignal("outbound_wbot_retry_blocked_ambiguous_delivery", 3, {
          attempt,
          status: Number(err?.statusCode || err?.status) || undefined
        });
      }

      if (!retryable || attempt === effectiveMaxAttempts) {
        if (retryable && !allowRetry) {
          bumpHardeningMetric("outbound.wbot_retry_blocked_missing_idempotency_key");
          pushHardeningSignal("outbound_wbot_retry_blocked_missing_idempotency_key", 3, {
            status: Number(err?.statusCode || err?.status) || undefined
          });
        }
        if (attempt === effectiveMaxAttempts && effectiveMaxAttempts > 1) {
          pushHardeningSignal("outbound_wbot_retry_exhausted", 3, { attempt, status: Number(err?.statusCode || err?.status) || undefined });
        }
        break;
      }
      bumpHardeningMetric("outbound.wbot_retry_attempt");
      pushHardeningSignal("outbound_wbot_retry", 6, { attempt });
      await sleep(computeBackoffMs(attempt));
    }
  }

  bumpHardeningMetric("outbound.wbot_send_failed");
  throw lastErr instanceof AppError ? lastErr : new AppError(lastErr?.message || "Error al enviar mensaje", 500);
};

const resolveTemplateVariables = (templateName: string, contactName: string, contactNeeds: string, incoming?: string[]): string[] => {
  const provided = Array.isArray(incoming) ? incoming.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (provided.length) return provided;

  const firstName = String(contactName || "").trim().split(/\s+/)[0] || "";
  const t = String(templateName || "").toLowerCase();
  const needs = String(contactNeeds || "").toLowerCase();

  if (/hola/.test(t) && firstName) return [firstName];
  if (/(lote|terreno)/.test(t)) return [firstName || "cliente", "lotes", needs || "tu búsqueda"];
  if (/(depto|departamento)/.test(t)) return [firstName || "cliente", "departamentos", needs || "tu búsqueda"];
  if (/(casa|casas)/.test(t)) return [firstName || "cliente", "casas", needs || "tu búsqueda"];
  if (/(inversion|inversi[oó]n)/.test(t)) return [firstName || "cliente", "inversión", needs || "tu búsqueda"];

  return firstName ? [firstName] : [];
};

const sendViaCloud = async (
  toRaw: string,
  payload: OutboundPayload,
  contactName = "",
  contactNeeds = "",
  clientIdempotencyKey = ""
): Promise<string> => {
  const cleanClientIdempotencyKey = normalizeClientIdempotencyKey(String(clientIdempotencyKey || ""));
  const hasClientIdempotencyKey = Boolean(cleanClientIdempotencyKey);
  const to = String(toRaw || "").replace(/\D/g, "");
  const settings = getRuntimeSettings();

  if (!to || !settings.waCloudPhoneNumberId || !settings.waCloudAccessToken) {
    throw new AppError("WhatsApp no conectado", 404);
  }

  const maxAttempts = Math.max(1, Math.min(6, Number(settings.waOutboundRetryMaxAttempts || 3)));
  const retryRequireIdempotencyKey = resolveOutboundRetryRequireIdempotencyKey();
  const allowRetryWithoutIdempotency = resolveOutboundAllowRetryWithoutIdempotencyKey();
  const allowRetry = hasClientIdempotencyKey || (!retryRequireIdempotencyKey && allowRetryWithoutIdempotency);
  const effectiveMaxAttempts = allowRetry ? maxAttempts : 1;

  if (!hasClientIdempotencyKey && maxAttempts > 1 && !allowRetry) {
    bumpHardeningMetric("outbound.cloud_retry_blocked_without_idempotency_policy");
    pushHardeningSignal("outbound_cloud_retry_blocked_without_idempotency_policy", 3, {
      maxAttempts,
      retryRequireIdempotencyKey,
      allowRetryWithoutIdempotency
    });
  }

  let lastErr: any;

  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const requestTimeoutMs = resolveOutboundRequestTimeoutMs();
      const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);

      const resp = await fetch(`https://graph.facebook.com/v21.0/${settings.waCloudPhoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.waCloudAccessToken}`,
          ...(cleanClientIdempotencyKey
            ? {
                // keep both canonical and de-facto header names for upstream/proxy compatibility
                "Idempotency-Key": cleanClientIdempotencyKey,
                "X-Idempotency-Key": cleanClientIdempotencyKey
              }
            : {})
        },
        body: JSON.stringify(
          payload.mode === "template"
            ? {
                messaging_product: "whatsapp",
                to,
                type: "template",
                template: {
                  name: String(payload.templateName || "").trim(),
                  language: { code: String(payload.languageCode || "es_AR").trim() },
                  ...(() => {
                    const vars = resolveTemplateVariables(
                      String(payload.templateName || ""),
                      String(contactName || ""),
                      String(contactNeeds || ""),
                      payload.templateVariables
                    );
                    if (!vars.length) return {};
                    return {
                      components: [
                        {
                          type: "body",
                          parameters: vars.map((v) => ({ type: "text", text: String(v) }))
                        }
                      ]
                    };
                  })()
                }
              }
            : payload.mode === "media"
              ? {
                  messaging_product: "whatsapp",
                  to,
                  type: payload.mediaType || "image",
                  [payload.mediaType || "image"]: {
                    link: String(payload.mediaUrl || "").trim(),
                    ...(payload.caption ? { caption: String(payload.caption) } : {})
                  }
                }
              : {
                  messaging_product: "whatsapp",
                  to,
                  type: "text",
                  text: { body: String(payload.text || "") }
                }
        ),
        signal: controller.signal
      }).finally(() => clearTimeout(timeoutHandle));

      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok) {
        bumpHardeningMetric("outbound.cloud_send_ok");
        return data?.messages?.[0]?.id || `meta-${Date.now()}`;
      }

      const cloudCode = Number(data?.error?.code);
      if (!isRetryableCloudFailure(resp.status, cloudCode) || attempt === effectiveMaxAttempts) {
        if (attempt === effectiveMaxAttempts) {
          pushHardeningSignal("outbound_retry_exhausted", 3, { status: resp.status, cloudCode });
        }
        throw new AppError(data?.error?.message || "Error al enviar mensaje", resp.status || 500);
      }

      if (resolveOutboundRetryRequireIdempotencyKey() && !hasClientIdempotencyKey) {
        bumpHardeningMetric("outbound.cloud_retry_blocked_missing_idempotency_key");
        pushHardeningSignal("outbound_cloud_retry_blocked_missing_idempotency_key", 3, { status: resp.status, cloudCode, attempt });
        throw new AppError("Reintento bloqueado por hardening: falta Idempotency-Key", resp.status || 502);
      }

      const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
      bumpHardeningMetric("outbound.cloud_retry_attempt");
      if (retryAfterMs && retryAfterMs > 0) bumpHardeningMetric("outbound.cloud_retry_after_header_used");
      pushHardeningSignal("outbound_retry", 8, { status: resp.status, cloudCode, attempt });
      await sleep(computeBackoffMs(attempt, retryAfterMs));
      continue;
    } catch (err: any) {
      lastErr = err;
      const isAbortTimeout = err?.name === "AbortError";
      if (isAbortTimeout) {
        bumpHardeningMetric("outbound.cloud_request_timeout");
        pushHardeningSignal("outbound_cloud_request_timeout", 4, { attempt });

        if (!resolveOutboundRetryOnTimeout(hasClientIdempotencyKey)) {
          bumpHardeningMetric("outbound.cloud_timeout_not_retried");
          pushHardeningSignal("outbound_cloud_timeout_not_retried", 3, { attempt });
          throw new AppError("Timeout enviando a WhatsApp Cloud; no se reintenta para evitar duplicados", 504);
        }
      }

      if (attempt === effectiveMaxAttempts) {
        pushHardeningSignal("outbound_retry_exhausted", 3, {
          status: Number(err?.statusCode || err?.status) || undefined,
          reason: isAbortTimeout ? "timeout" : undefined
        });
        break;
      }
      const status = Number(err?.statusCode || err?.status);
      if (!isAbortTimeout && !isRetryableCloudFailure(status)) throw err;

      // hardening: unknown transport failures are ambiguous delivery paths; never blind-retry without explicit client idempotency key
      if (!isAbortTimeout && !status && !hasClientIdempotencyKey) {
        bumpHardeningMetric("outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key");
        pushHardeningSignal("outbound_cloud_retry_blocked_unknown_transport_without_idempotency_key", 3, {
          attempt
        });
        throw new AppError("Reintento bloqueado por hardening: error de transporte ambiguo sin Idempotency-Key", 502);
      }

      if (resolveOutboundRetryRequireIdempotencyKey() && !hasClientIdempotencyKey) {
        bumpHardeningMetric("outbound.cloud_retry_blocked_missing_idempotency_key");
        pushHardeningSignal("outbound_cloud_retry_blocked_missing_idempotency_key", 3, {
          status: status || undefined,
          attempt,
          reason: isAbortTimeout ? "timeout" : undefined
        });
        throw new AppError("Reintento bloqueado por hardening: falta Idempotency-Key", isAbortTimeout ? 504 : (status || 502));
      }

      const retryAfterMs = parseRetryAfterMs(err?.response?.headers?.["retry-after"] || err?.headers?.["retry-after"]);
      bumpHardeningMetric("outbound.cloud_retry_attempt");
      if (retryAfterMs && retryAfterMs > 0) bumpHardeningMetric("outbound.cloud_retry_after_header_used");
      pushHardeningSignal("outbound_retry", 8, { status, attempt, reason: isAbortTimeout ? "timeout" : undefined });
      await sleep(computeBackoffMs(attempt, retryAfterMs));
    }
  }

  bumpHardeningMetric("outbound.cloud_send_failed");
  throw lastErr instanceof AppError ? lastErr : new AppError("Error al enviar mensaje", 500);
};

const SendMessageService = async ({ body, ticketId, templateName, languageCode, templateVariables, mediaUrl, mediaType, caption, idempotencyKey }: SendMessageRequest): Promise<Message> => {
  if (!ticketId) {
    throw new AppError("ticketId requerido", 400);
  }

  const ticket = await Ticket.findByPk(ticketId, {
    include: [
      { model: Contact, as: "contact" },
      { model: require("../../models/Whatsapp").default, as: "whatsapp" }
    ]
  });

  if (!ticket) {
    throw new AppError("Ticket no encontrado", 404);
  }

  const sanitizedBody = String(body || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();

  const cleanTemplateName = String(templateName || "").trim();
  const cleanMediaUrl = String(mediaUrl || "").trim();
  const cleanCaption = String(caption || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  const cleanLanguageCode = String(languageCode || "es_AR").trim() || "es_AR";
  const rawIdempotencyKey = String(idempotencyKey || "").trim();
  const cleanIdempotencyKey = normalizeClientIdempotencyKey(rawIdempotencyKey);

  if (rawIdempotencyKey.length > OUTBOUND_IDEMPOTENCY_KEY_MAX_LENGTH) {
    bumpHardeningMetric("outbound.idempotency_key_too_long_blocked");
    pushHardeningSignal("outbound_idempotency_key_too_long_blocked", 3, {
      ticketId: ticket.id,
      observedLength: rawIdempotencyKey.length,
      maxLength: OUTBOUND_IDEMPOTENCY_KEY_MAX_LENGTH
    });
    throw new AppError(`Hardening: Idempotency-Key demasiado largo (max ${OUTBOUND_IDEMPOTENCY_KEY_MAX_LENGTH})`, 400);
  }

  if (rawIdempotencyKey && hasInvalidClientIdempotencyChars(rawIdempotencyKey)) {
    bumpHardeningMetric("outbound.idempotency_key_invalid_chars_blocked");
    pushHardeningSignal("outbound_idempotency_key_invalid_chars_blocked", 3, { ticketId: ticket.id });
    throw new AppError("Hardening: Idempotency-Key contiene caracteres inválidos", 400);
  }

  if (rawIdempotencyKey && !cleanIdempotencyKey) {
    bumpHardeningMetric("outbound.invalid_idempotency_key_blocked");
    pushHardeningSignal("outbound_invalid_idempotency_key_blocked", 3, { ticketId: ticket.id });
    throw new AppError("Idempotency-Key invalido", 400);
  }

  if (cleanIdempotencyKey && cleanIdempotencyKey.length < resolveOutboundIdempotencyKeyMinLength()) {
    bumpHardeningMetric("outbound.idempotency_key_too_short_blocked");
    pushHardeningSignal("outbound_idempotency_key_too_short_blocked", 3, {
      ticketId: ticket.id,
      observedLength: cleanIdempotencyKey.length,
      minLength: resolveOutboundIdempotencyKeyMinLength()
    });
    throw new AppError(`Hardening: Idempotency-Key demasiado corto (min ${resolveOutboundIdempotencyKeyMinLength()})`, 400);
  }

  if (cleanIdempotencyKey && isTimestampOnlyIdempotencyKey(cleanIdempotencyKey)) {
    bumpHardeningMetric("outbound.idempotency_key_timestamp_only_blocked");
    pushHardeningSignal("outbound_idempotency_key_timestamp_only_blocked", 2, {
      ticketId: ticket.id
    });
    bumpHardeningMetric("outbound.idempotency_key_too_weak_blocked");
    pushHardeningSignal("outbound_idempotency_key_too_weak_blocked", 3, {
      ticketId: ticket.id,
      weakReason: "timestamp_only"
    });
    throw new AppError("Hardening: Idempotency-Key timestamp-only no permitido (usar UUID/ULID o clave con entropía real)", 400);
  }

  if (cleanIdempotencyKey && isWeakClientIdempotencyKey(cleanIdempotencyKey)) {
    bumpHardeningMetric("outbound.idempotency_key_too_weak_blocked");
    pushHardeningSignal("outbound_idempotency_key_too_weak_blocked", 3, {
      ticketId: ticket.id
    });
    throw new AppError("Hardening: Idempotency-Key demasiado débil (usar caracteres no secuenciales y al menos 2 distintos)", 400);
  }

  if (resolveOutboundRequireIdempotencyKey() && !cleanIdempotencyKey) {
    bumpHardeningMetric("outbound.missing_idempotency_key_blocked");
    pushHardeningSignal("outbound_missing_idempotency_key_blocked", 3, {
      ticketId: ticket.id
    });
    throw new AppError("Hardening: Idempotency-Key requerido para outbound", 400);
  }

  const payload: OutboundPayload = cleanTemplateName
    ? {
        mode: "template",
        templateName: cleanTemplateName,
        languageCode: cleanLanguageCode,
        templateVariables: Array.isArray(templateVariables) ? templateVariables : undefined
      }
    : cleanMediaUrl
      ? { mode: "media", mediaUrl: cleanMediaUrl, mediaType: (mediaType || "image") as OutboundMediaType, caption: cleanCaption }
      : { mode: "text", text: sanitizedBody };

  if (payload.mode === "text" && !sanitizedBody) {
    bumpHardeningMetric("outbound.empty_text_blocked");
    pushHardeningSignal("outbound_empty_text_blocked", 3, { ticketId: ticket.id });
    throw new AppError("Mensaje vacío no permitido", 400);
  }

  if (payload.mode === "media" && !cleanMediaUrl) {
    throw new AppError("Media URL requerida", 400);
  }

  const previousMessagesCount = await Message.count({ where: { ticketId: ticket.id } });
  const isFirstContact = previousMessagesCount === 0;

  const enforceFirstContactHolaTemplate = Boolean((getRuntimeSettings() as any).waFirstContactHolaTemplateRequired ?? true);

  if (isFirstContact && enforceFirstContactHolaTemplate) {
    if (payload.mode !== "template") {
      bumpHardeningMetric("outbound.first_contact_template_required_blocked");
      pushHardeningSignal("outbound_first_contact_template_required_blocked", 3, { ticketId: ticket.id, mode: payload.mode });
      throw new AppError("Primer contacto: debés usar template de Hola", 400);
    }

    if (!/hola/i.test(String(payload.templateName || ""))) {
      bumpHardeningMetric("outbound.first_contact_hola_template_required_blocked");
      pushHardeningSignal("outbound_first_contact_hola_template_required_blocked", 3, {
        ticketId: ticket.id,
        templateName: String(payload.templateName || "")
      });
      throw new AppError("Primer contacto: el template debe ser el de Hola", 400);
    }
  }

  try {
    let msgId: any = crypto.randomUUID();
    const wbot = getWbot(ticket.whatsappId);

    const tenantScope = `company:${String((ticket as any)?.companyId || "na")}:wa:${String((ticket as any)?.whatsappId || "na")}`;
    const dedupeKey = buildOutboundDedupeKey(ticket.id, ticket.contact.number, payload, cleanIdempotencyKey, tenantScope);
    if (cleanIdempotencyKey) {
      bumpHardeningMetric("outbound.idempotency_key_used");
    } else {
      bumpHardeningMetric("outbound.idempotency_key_missing");
      pushHardeningSignal("outbound_missing_idempotency_key", 20, {
        ticketId: ticket.id,
        mode: payload.mode
      });
    }
    const dedupeTtlSeconds = resolveOutboundDedupeTtlSeconds();
    let shouldSend = true;
    let dedupeReservationMode: "persistent" | "emergency" = "persistent";
    try {
      shouldSend = await reserveOutboundDedupe(dedupeKey, dedupeTtlSeconds);
    } catch (dedupeErr: any) {
      bumpHardeningMetric("outbound.dedupe_infra_error");
      pushHardeningSignal("outbound_dedupe_infra_error", 3, { ticketId: ticket.id, mode: payload.mode });

      if (resolveOutboundDedupeFailClosed()) {
        bumpHardeningMetric("outbound.dedupe_fail_closed_blocked");
        pushHardeningSignal("outbound_dedupe_fail_closed_blocked", 2, { ticketId: ticket.id, mode: payload.mode });
        console.error("[wa-hardening] outbound dedupe infra failed; fail-closed mode blocked outbound", {
          ticketId: ticket.id,
          mode: payload.mode,
          error: dedupeErr?.message || String(dedupeErr)
        });
        throw new AppError("Bloqueado por hardening: dedupe outbound no disponible", 503);
      }

      console.error("[wa-hardening] outbound dedupe infra failed; using emergency memory dedupe", {
        ticketId: ticket.id,
        mode: payload.mode,
        error: dedupeErr?.message || String(dedupeErr)
      });

      dedupeReservationMode = "emergency";
      shouldSend = reserveOutboundDedupeEmergency(dedupeKey, dedupeTtlSeconds);
      if (shouldSend) {
        bumpHardeningMetric("outbound.dedupe_emergency_reserved");
        bumpOutboundModeMetric("outbound.dedupe_emergency_reserved_mode", payload.mode);
      } else {
        bumpHardeningMetric("outbound.dedupe_emergency_duplicate_blocked");
        bumpOutboundModeMetric("outbound.dedupe_emergency_duplicate_blocked_mode", payload.mode);
      }
    }

    if (!shouldSend) {
      bumpHardeningMetric("outbound.duplicate_blocked");
      bumpOutboundModeMetric("outbound.duplicate_blocked_mode", payload.mode);
      if (cleanIdempotencyKey) {
        bumpHardeningMetric("outbound.duplicate_blocked_with_idempotency_key");
        pushHardeningSignal("outbound_duplicate_blocked_with_idempotency_key", 4, {
          ticketId: ticket.id,
          mode: payload.mode
        });
      } else {
        bumpHardeningMetric("outbound.duplicate_blocked_without_idempotency_key");
      }
      pushHardeningSignal("outbound_duplicate_blocked", 5, { ticketId: ticket.id, mode: payload.mode });
      throw new AppError(`Mensaje duplicado bloqueado (ventana ${dedupeTtlSeconds}s)`, 409);
    }
    bumpHardeningMetric("outbound.dedupe_reserved");
    bumpOutboundModeMetric("outbound.dedupe_reserved_mode", payload.mode);

    try {
      if (wbot) {
        msgId = await sendViaWbot(wbot, ticket.contact.number, payload, Boolean(cleanIdempotencyKey));
      } else {
        msgId = await sendViaCloud(
          ticket.contact.number,
          payload,
          String((ticket as any)?.contact?.name || ""),
          String((ticket as any)?.contact?.needs || ""),
          cleanIdempotencyKey
        );
      }
    } catch (sendErr: any) {
      bumpHardeningMetric("outbound.provider_send_failed");

      if (shouldReleaseDedupeAfterProviderFailure(sendErr)) {
        if (dedupeReservationMode === "persistent") {
          try {
            await releaseOutboundDedupe(dedupeKey);
            bumpHardeningMetric("outbound.dedupe_released_after_non_retryable_provider_error");
          } catch (releaseErr: any) {
            bumpHardeningMetric("outbound.dedupe_release_failed_after_non_retryable_provider_error");
            console.error("[wa-hardening] failed to release dedupe key after non-retryable provider error", {
              dedupeKey,
              error: releaseErr?.message || String(releaseErr)
            });
          }
        } else {
          const released = releaseOutboundDedupeEmergency(dedupeKey);
          if (released) {
            bumpHardeningMetric("outbound.dedupe_released_after_non_retryable_provider_error_emergency_mode");
          } else {
            bumpHardeningMetric("outbound.dedupe_release_not_found_after_non_retryable_provider_error_emergency_mode");
          }
        }
      } else {
        bumpHardeningMetric("outbound.dedupe_retained_after_provider_failure");
      }

      throw sendErr;
    }

    const persistedBody = payload.mode === "template"
      ? `[TEMPLATE:${payload.templateName}] idioma=${payload.languageCode}`
      : payload.mode === "media"
        ? `${payload.caption ? `${payload.caption}\n` : ''}${String(payload.mediaUrl || '').trim()}`.trim()
        : String(payload.text || "");

    const persistedMediaType = payload.mode === "template"
      ? "template"
      : payload.mode === "media"
        ? String(payload.mediaType || "image")
        : "chat";

    const message = await Message.create({
      id: msgId,
      body: persistedBody,
      contactId: ticket.contactId,
      ticketId: ticket.id,
      fromMe: true,
      read: true,
      ack: 0,
      mediaType: persistedMediaType
    } as any);
    bumpHardeningMetric("outbound.message_persisted");

    await ticket.update({
      lastMessage: persistedBody,
      updatedAt: new Date()
    });

    const io = getIO();
    io.to(`ticket-${ticket.id}`).emit("appMessage", {
      action: "create",
      message,
      ticket,
      contact: ticket.contact
    });

    return message;
  } catch (error) {
    bumpHardeningMetric("outbound.send_service_error");
    console.error("Error al enviar mensaje:", error);
    throw error instanceof AppError ? error : new AppError("Error al enviar mensaje", 500);
  }
};

export default SendMessageService;
