import crypto from "crypto";
import { Op, QueryTypes } from "sequelize";

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Whatsapp from "../../models/Whatsapp";
import Tag from "../../models/Tag";
import ContactTag from "../../models/ContactTag";
import sequelize from "../../database";
import { getIO } from "../../libs/socket";
import { recordInboundDuplicate, recordInboundError, recordInboundMessage } from "../../utils/messageStats";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";

type MetaWebhookPayload = { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }> } }> }> };
type ConversationType = "sales" | "support" | "scheduling" | "general";
type Policy = { maxReplyChars?: number; allowAutoClose?: boolean; autoHandoffOnSensitive?: boolean; forbiddenKeywords?: string[] };

const defaultPolicies: Record<ConversationType, Policy> = {
  sales: { maxReplyChars: 280, allowAutoClose: false, autoHandoffOnSensitive: false, forbiddenKeywords: ["descuento extremo", "garantía absoluta"] },
  support: { maxReplyChars: 320, allowAutoClose: false, autoHandoffOnSensitive: true, forbiddenKeywords: ["culpa del cliente"] },
  scheduling: { maxReplyChars: 220, allowAutoClose: true, autoHandoffOnSensitive: false, forbiddenKeywords: [] },
  general: { maxReplyChars: 260, allowAutoClose: true, autoHandoffOnSensitive: false, forbiddenKeywords: [] }
};

const MAX_WEBHOOK_MESSAGE_AGE_SECONDS = 60 * 60 * 24; // 24h
const MAX_WEBHOOK_FUTURE_SKEW_SECONDS = 60 * 5; // 5m
const MAX_INBOUND_TEXT_LENGTH = 4096;
const MAX_INBOUND_MESSAGES_PER_PAYLOAD = 200;
const DEFAULT_MAX_INBOUND_REPLAY_BLOCKS_PER_PAYLOAD = 40;
const ALLOWED_INBOUND_TYPES = new Set(["text", "image", "audio", "video", "document", "sticker", "interactive", "button"]);

let decisionTableReady = false;
let outboundDedupeTableReady = false;
let outboundDedupeLastPruneAt = 0;
let inboundReplayTableReady = false;
let inboundReplayLastPruneAt = 0;
const INBOUND_REPLAY_TTL_SECONDS = 60 * 60 * 24; // 24h
const OUTBOUND_DEDUPE_PRUNE_INTERVAL_MS = 60 * 1000;
const INBOUND_REPLAY_PRUNE_INTERVAL_MS = 60 * 1000;
const DEFAULT_OUTBOUND_DEDUPE_MEMORY_MAX_ENTRIES = 5000;
const outboundDedupeMemory = new Map<string, number>();

const resolveInboundReplayTtlSeconds = () => {
  const n = Number(getRuntimeSettings().waInboundReplayTtlSeconds || INBOUND_REPLAY_TTL_SECONDS);
  if (!Number.isFinite(n)) return INBOUND_REPLAY_TTL_SECONDS;
  return Math.max(300, Math.min(60 * 60 * 24 * 7, Math.round(n)));
};

const resolveInboundReplayMaxBlocksPerPayload = () => {
  const n = Number(getRuntimeSettings().waInboundReplayMaxBlocksPerPayload || DEFAULT_MAX_INBOUND_REPLAY_BLOCKS_PER_PAYLOAD);
  if (!Number.isFinite(n)) return DEFAULT_MAX_INBOUND_REPLAY_BLOCKS_PER_PAYLOAD;
  return Math.max(5, Math.min(500, Math.round(n)));
};

const resolveOutboundDedupeTtlSeconds = () => {
  const n = Number(getRuntimeSettings().waOutboundDedupeTtlSeconds || 120);
  if (!Number.isFinite(n)) return 120;
  return Math.max(30, Math.min(900, Math.round(n)));
};

const resolveOutboundDedupeMemoryMaxEntries = () => {
  const n = Number((getRuntimeSettings() as any).waOutboundDedupeMemoryMaxEntries || DEFAULT_OUTBOUND_DEDUPE_MEMORY_MAX_ENTRIES);
  if (!Number.isFinite(n)) return DEFAULT_OUTBOUND_DEDUPE_MEMORY_MAX_ENTRIES;
  return Math.max(200, Math.min(20000, Math.round(n)));
};

const parseBooleanRuntimeSetting = (raw: any, defaultValue: boolean): boolean => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const resolveOutboundDedupeFailClosed = () => parseBooleanRuntimeSetting((getRuntimeSettings() as any).waOutboundDedupeFailClosed, true);

const trimOutboundDedupeMemory = (maxEntries: number) => {
  if (outboundDedupeMemory.size <= maxEntries) return;
  const overflow = outboundDedupeMemory.size - maxEntries;
  let trimmed = 0;
  for (const key of outboundDedupeMemory.keys()) {
    outboundDedupeMemory.delete(key);
    trimmed += 1;
    if (trimmed >= overflow) break;
  }
  if (trimmed > 0) {
    bumpHardeningMetric("outbound.dedupe_memory_trimmed", trimmed);
  }
};

const ensureDecisionTable = async () => {
  if (decisionTableReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ai_decision_logs (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, ticket_id INTEGER NOT NULL, conversation_type VARCHAR(32) NOT NULL, decision_key VARCHAR(80) NOT NULL, reason TEXT, guardrail_action VARCHAR(80), response_preview TEXT, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  decisionTableReady = true;
};

const ensureOutboundDedupeTable = async () => {
  if (outboundDedupeTableReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ai_outbound_dedupe (id SERIAL PRIMARY KEY, dedupe_key VARCHAR(220) UNIQUE NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_outbound_dedupe_key ON ai_outbound_dedupe(dedupe_key)`);
  // pruning runs every minute; keep created_at indexed to avoid full scans under outbound retry bursts
  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ai_outbound_dedupe_created_at ON ai_outbound_dedupe(created_at)`);
  outboundDedupeTableReady = true;
};

const pruneOutboundDedupeIfDue = async (ttlSeconds: number) => {
  const now = Date.now();
  if (now - outboundDedupeLastPruneAt < OUTBOUND_DEDUPE_PRUNE_INTERVAL_MS) {
    bumpHardeningMetric("outbound.dedupe_prune_skipped");
    return;
  }
  outboundDedupeLastPruneAt = now;
  bumpHardeningMetric("outbound.dedupe_prune_runs");
  await sequelize.query(`DELETE FROM ai_outbound_dedupe WHERE created_at < NOW() - (:ttlSeconds::text || ' seconds')::interval`, {
    replacements: { ttlSeconds },
    type: QueryTypes.DELETE
  });
};

const reserveOutboundDedupe = async (dedupeKey: string, ttlSeconds = 120): Promise<boolean> => {
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

const reserveOutboundDedupeMemory = (dedupeKey: string, ttlSeconds: number): boolean => {
  const now = Date.now();
  for (const [key, expiresAt] of outboundDedupeMemory.entries()) {
    if (expiresAt <= now) outboundDedupeMemory.delete(key);
  }

  trimOutboundDedupeMemory(resolveOutboundDedupeMemoryMaxEntries());

  const existingExpiresAt = outboundDedupeMemory.get(dedupeKey) || 0;
  if (existingExpiresAt > now) return false;
  outboundDedupeMemory.set(dedupeKey, now + Math.max(1000, ttlSeconds * 1000));

  trimOutboundDedupeMemory(resolveOutboundDedupeMemoryMaxEntries());

  return true;
};

const ensureInboundReplayTable = async () => {
  if (inboundReplayTableReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ai_inbound_replay_guard (id SERIAL PRIMARY KEY, replay_key VARCHAR(220) UNIQUE NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_inbound_replay_guard_key ON ai_inbound_replay_guard(replay_key)`);
  // replay-prune runs every minute; created_at index keeps delete cost bounded when webhook volume spikes
  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ai_inbound_replay_guard_created_at ON ai_inbound_replay_guard(created_at)`);
  inboundReplayTableReady = true;
};

const buildInboundReplayKey = (messageId: string, from: string) => {
  const base = `${String(messageId || "").trim()}:${String(from || "").replace(/\D/g, "")}`;
  return `wa-in:${crypto.createHash("sha1").update(base).digest("hex")}`;
};

const pruneInboundReplayIfDue = async (ttlSeconds: number) => {
  const now = Date.now();
  if (now - inboundReplayLastPruneAt < INBOUND_REPLAY_PRUNE_INTERVAL_MS) {
    bumpHardeningMetric("inbound.replay_prune_skipped");
    return;
  }
  inboundReplayLastPruneAt = now;
  bumpHardeningMetric("inbound.replay_prune_runs");
  await sequelize.query(`DELETE FROM ai_inbound_replay_guard WHERE created_at < NOW() - (:ttlSeconds::text || ' seconds')::interval`, {
    replacements: { ttlSeconds },
    type: QueryTypes.DELETE
  });
};

const reserveInboundReplay = async (replayKey: string, ttlSeconds = INBOUND_REPLAY_TTL_SECONDS): Promise<boolean> => {
  await ensureInboundReplayTable();
  await pruneInboundReplayIfDue(ttlSeconds);
  const rows: any[] = await sequelize.query(
    `INSERT INTO ai_inbound_replay_guard (replay_key, created_at)
     VALUES (:replayKey, NOW())
     ON CONFLICT (replay_key) DO NOTHING
     RETURNING replay_key`,
    { replacements: { replayKey }, type: QueryTypes.SELECT }
  );
  return Boolean(rows[0]?.replay_key);
};

const releaseInboundReplay = async (replayKey: string) => {
  await sequelize.query(`DELETE FROM ai_inbound_replay_guard WHERE replay_key = :replayKey`, {
    replacements: { replayKey },
    type: QueryTypes.DELETE
  });
};

const logDecision = async (args: { companyId: number; ticketId: number; conversationType: ConversationType; decisionKey: string; reason?: string; guardrailAction?: string; responsePreview?: string }) => {
  try {
    await ensureDecisionTable();
    await sequelize.query(`INSERT INTO ai_decision_logs (company_id, ticket_id, conversation_type, decision_key, reason, guardrail_action, response_preview, created_at) VALUES (:companyId, :ticketId, :conversationType, :decisionKey, :reason, :guardrailAction, :responsePreview, NOW())`, { replacements: args, type: QueryTypes.INSERT });
  } catch (error: any) {
    console.warn("[wa-cloud][decision-log] skipped", {
      ticketId: args.ticketId,
      decisionKey: args.decisionKey,
      error: error?.message || String(error)
    });
  }
};
const resolvePolicies = (): Record<ConversationType, Policy> => {
  const rt = getRuntimeSettings();
  if (!rt.agentGuardrailsEnabled) return defaultPolicies;
  try {
    const parsed = JSON.parse(rt.agentConversationPoliciesJson || "{}");
    return { sales: { ...defaultPolicies.sales, ...(parsed.sales || {}) }, support: { ...defaultPolicies.support, ...(parsed.support || {}) }, scheduling: { ...defaultPolicies.scheduling, ...(parsed.scheduling || {}) }, general: { ...defaultPolicies.general, ...(parsed.general || {}) } };
  } catch { return defaultPolicies; }
};
const classifyConversation = (text: string): ConversationType => {
  const t = String(text || "").toLowerCase();
  if (/turno|agenda|cita|horario|fecha|mañana|lunes|martes/.test(t)) return "scheduling";
  if (/error|soporte|no funciona|problema|incidente|ca[ií]do/.test(t)) return "support";
  if (/precio|plan|comprar|contratar|promo|descuento|cotiz/.test(t)) return "sales";
  return "general";
};
const applyGuardrails = async ({ text, reply, conversationType }: { text: string; reply: string; conversationType: ConversationType }): Promise<{ finalReply?: string; handoff?: boolean; reason: string; action: string }> => {
  const policy = resolvePolicies()[conversationType] || defaultPolicies.general;
  const low = text.toLowerCase();
  if (policy.autoHandoffOnSensitive && /legal|abogado|demanda|tarjeta|transferencia|cbu/.test(low)) return { handoff: true, reason: "Tema sensible detectado para soporte", action: "handoff_sensitive" };
  const forbidden = (policy.forbiddenKeywords || []).find((k) => k && reply.toLowerCase().includes(k.toLowerCase()));
  let safeReply = forbidden ? "Gracias por tu consulta. Te derivo con un asesor humano para darte una respuesta precisa." : reply;
  if (conversationType === "scheduling" && !/\d{1,2}[:.]\d{2}|mañana|tarde|noche|lunes|martes|miércoles|jueves|viernes|sábado|domingo/.test(low)) safeReply = "Perfecto, lo coordinamos. Indicame por favor día y franja horaria (ej: martes 15:30).";
  const max = Number(policy.maxReplyChars || 260);
  if (safeReply.length > max) safeReply = `${safeReply.slice(0, Math.max(60, max - 1))}…`;
  return { finalReply: safeReply, reason: forbidden ? `Keyword bloqueada: ${forbidden}` : "Guardrails aplicados", action: forbidden ? "rewrite_forbidden" : "allow" };
};

const resolveWhatsapp = async () => {
  const runtime = getRuntimeSettings();
  const preferredId = Number(runtime.waCloudDefaultWhatsappId || 0);
  if (preferredId > 0) { const byId = await Whatsapp.findByPk(preferredId); if (byId) return byId; }
  const byDefault = await Whatsapp.findOne({ where: { isDefault: true } }); if (byDefault) return byDefault;
  const anyWhatsapp = await Whatsapp.findOne(); if (anyWhatsapp) return anyWhatsapp;
  return Whatsapp.create({ name: "WhatsApp Cloud", status: "CONNECTED", isDefault: true, companyId: 1 } as any);
};
const getOrCreateContact = async (phone: string, companyId: number) => {
  let contact = await Contact.findOne({ where: { number: phone, companyId } });
  if (!contact) contact = await Contact.create({ name: phone, number: phone, companyId, isGroup: false });
  return contact;
};
const getOrCreateTicket = async (contactId: number, whatsappId: number, companyId: number) => {
  let ticket = await Ticket.findOne({ where: { contactId, whatsappId, status: { [Op.ne]: "closed" } }, order: [["updatedAt", "DESC"]] });
  if (!ticket) ticket = await Ticket.create({ contactId, whatsappId, companyId, status: "pending", unreadMessages: 1, lastMessage: "" } as any);
  return ticket;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HARDENING_ALERT_WINDOW_MS = 10 * 60 * 1000;
const hardeningSignalBuckets = new Map<string, number[]>();
const hardeningSignalThresholds = new Map<string, number>();
const hardeningMetricCounters = new Map<string, number>();
const hardeningMetricLastAt = new Map<string, string>();

const bumpHardeningMetric = (metric: string, by = 1) => {
  const next = (hardeningMetricCounters.get(metric) || 0) + by;
  hardeningMetricCounters.set(metric, next);
  hardeningMetricLastAt.set(metric, new Date().toISOString());
};

export const getWaHardeningMetrics = () => {
  const counters = Object.fromEntries(Array.from(hardeningMetricCounters.entries()).sort((a, b) => a[0].localeCompare(b[0])));
  const lastSeenAt = Object.fromEntries(Array.from(hardeningMetricLastAt.entries()).sort((a, b) => a[0].localeCompare(b[0])));

  const toNum = (key: string) => Number((counters as any)[key] || 0);
  const safeRate = (num: number, den: number) => (den > 0 ? Number((num / den).toFixed(4)) : 0);

  const outboundDuplicateBlocked = toNum("outbound.duplicate_blocked");
  const outboundDedupeReserved = toNum("outbound.dedupe_reserved");
  const outboundProviderSendFailed = toNum("outbound.provider_send_failed");
  const outboundCloudSendOk = toNum("outbound.cloud_send_ok");
  const inboundReplayBlocked = toNum("inbound.replay_blocked");
  const inboundProcessedOk = toNum("inbound.processed_ok");

  return {
    counters,
    lastSeenAt,
    derived: {
      outboundDuplicateBlockRate: safeRate(outboundDuplicateBlocked, outboundDuplicateBlocked + outboundDedupeReserved),
      outboundProviderFailureRate: safeRate(outboundProviderSendFailed, outboundProviderSendFailed + outboundCloudSendOk),
      inboundReplayBlockRate: safeRate(inboundReplayBlocked, inboundReplayBlocked + inboundProcessedOk)
    }
  };
};

export const getWaHardeningAlertSnapshot = () => {
  const now = Date.now();
  const pendingAlerts = Array.from(hardeningSignalBuckets.entries())
    .map(([signal, hits]) => {
      const threshold = hardeningSignalThresholds.get(signal) || 0;
      const inWindow = hits.filter((ts) => now - ts < HARDENING_ALERT_WINDOW_MS).length;
      return { signal, threshold, inWindow, remaining: Math.max(0, threshold - inWindow) };
    })
    .filter((entry) => entry.threshold > 0 && entry.inWindow > 0)
    .sort((a, b) => b.inWindow - a.inWindow || a.signal.localeCompare(b.signal));

  const metrics = getWaHardeningMetrics();
  const counters: any = metrics.counters || {};
  const derived: any = metrics.derived || {};

  const outboundTotalAttempted = Number(counters["outbound.dedupe_reserved"] || 0) + Number(counters["outbound.duplicate_blocked"] || 0);
  if (outboundTotalAttempted >= 20 && Number(derived.outboundDuplicateBlockRate || 0) >= 0.2) {
    pendingAlerts.push({
      signal: "outbound_duplicate_block_rate_high",
      threshold: 0.2,
      inWindow: Number(derived.outboundDuplicateBlockRate || 0),
      remaining: 0,
      sampleSize: outboundTotalAttempted
    } as any);
  }

  const inboundTotalObserved = Number(counters["inbound.processed_ok"] || 0) + Number(counters["inbound.replay_blocked"] || 0);
  if (inboundTotalObserved >= 20 && Number(derived.inboundReplayBlockRate || 0) >= 0.15) {
    pendingAlerts.push({
      signal: "inbound_replay_block_rate_high",
      threshold: 0.15,
      inWindow: Number(derived.inboundReplayBlockRate || 0),
      remaining: 0,
      sampleSize: inboundTotalObserved
    } as any);
  }

  const outboundProviderTotalObserved = Number(counters["outbound.provider_send_failed"] || 0) + Number(counters["outbound.cloud_send_ok"] || 0);
  if (outboundProviderTotalObserved >= 20 && Number(derived.outboundProviderFailureRate || 0) >= 0.1) {
    pendingAlerts.push({
      signal: "outbound_provider_failure_rate_high",
      threshold: 0.1,
      inWindow: Number(derived.outboundProviderFailureRate || 0),
      remaining: 0,
      sampleSize: outboundProviderTotalObserved
    } as any);
  }

  return {
    windowMs: HARDENING_ALERT_WINDOW_MS,
    pendingAlerts: pendingAlerts.sort((a: any, b: any) => {
      const ai = Number(a.inWindow || 0);
      const bi = Number(b.inWindow || 0);
      return bi - ai || String(a.signal).localeCompare(String(b.signal));
    })
  };
};

const pushHardeningSignal = (signal: string, threshold: number, context?: Record<string, unknown>) => {
  hardeningSignalThresholds.set(signal, Math.max(1, Number(threshold) || 1));
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

export const recordInboundSignatureInvalidBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.signature_invalid_blocked");
  pushHardeningSignal("inbound_signature_invalid_blocked", 4, context);
};

export const recordInboundSignatureMissingBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.signature_missing_blocked");
  pushHardeningSignal("inbound_signature_missing_blocked", 2, context);
};

export const recordInboundSignatureMalformedBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.signature_malformed_blocked");
  pushHardeningSignal("inbound_signature_malformed_blocked", 2, context);
};

export const recordInboundSignatureInvalidRateLimited = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.signature_invalid_rate_limited");
  pushHardeningSignal("inbound_signature_invalid_rate_limited", 3, context);
};

export const recordInboundPayloadReplayBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.payload_replay_blocked");
  pushHardeningSignal("inbound_payload_replay_blocked", 4, context);
};

export const recordInboundPayloadReplayCacheTrimmed = (removed: number, context?: Record<string, unknown>) => {
  const trimmed = Math.max(0, Math.round(Number(removed) || 0));
  if (trimmed <= 0) return;
  bumpHardeningMetric("inbound.payload_replay_cache_trimmed", trimmed);
  pushHardeningSignal("inbound_payload_replay_cache_trimmed", 10, { removed: trimmed, ...context });
};

export const recordInboundPayloadReplayGuardInfraError = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.payload_replay_guard_infra_error");
  pushHardeningSignal("inbound_payload_replay_guard_infra_error", 2, context);
};

export const recordInboundPayloadReplayGuardFailClosedBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.payload_replay_guard_fail_closed_blocked");
  pushHardeningSignal("inbound_payload_replay_guard_fail_closed_blocked", 2, context);
};

export const recordInboundPayloadOversizeBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.payload_size_blocked");
  pushHardeningSignal("inbound_payload_size_blocked", 2, context);
};

export const recordInboundInvalidEnvelopeBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.invalid_envelope_blocked");
  pushHardeningSignal("inbound_invalid_envelope_blocked", 3, context);
};

export const recordInboundInvalidContentTypeBlocked = (context?: Record<string, unknown>) => {
  bumpHardeningMetric("inbound.invalid_content_type_blocked");
  pushHardeningSignal("inbound_invalid_content_type_blocked", 3, context);
};

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

const resolveOutboundRetryOnTimeout = (): boolean => {
  // Managed replies do not carry a client idempotency key through provider hops.
  // Timeout retries are the highest duplicate-risk path (provider may have accepted first send before timeout).
  // Hardening: force no-timeout-retry for managed outbound until end-to-end idempotency is available.
  return false;
};

const resolveOutboundRetryRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any).waOutboundRetryRequireIdempotencyKey;
  // hardening default: retries without explicit idempotency key are duplicate-prone
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
};

const resolveManagedReplyRetryRequireIdempotencyKey = (): boolean => {
  const settings = getRuntimeSettings() as any;
  const specific = settings.waManagedReplyRetryRequireIdempotencyKey;
  // if explicit managed-reply policy is not set, inherit global outbound retry hardening
  if (specific === undefined || specific === null || String(specific).trim() === "") {
    return resolveOutboundRetryRequireIdempotencyKey();
  }
  return ["1", "true", "yes", "on"].includes(String(specific).toLowerCase());
};

const applyRetryJitter = (ms: number, maxDelayMs: number): number => {
  if (ms <= 0) return 0;
  const multiplier = 0.9 + (Math.random() * 0.2); // ±10%
  const jittered = Math.round(ms * multiplier);
  return Math.max(200, Math.min(jittered, maxDelayMs));
};

const computeBackoffMs = (attempt: number, retryAfterMs?: number | null): number => {
  const maxDelayMs = resolveOutboundRetryMaxDelayMs();
  if (retryAfterMs && retryAfterMs > 0) return applyRetryJitter(Math.min(retryAfterMs, maxDelayMs), maxDelayMs);
  const base = 400 * Math.pow(2, attempt - 1);
  return applyRetryJitter(base, maxDelayMs);
};

const isRetryableCloudFailure = (status?: number, code?: number): boolean => {
  if (!status) return true;
  // 409 can happen in conflict windows; retrying can amplify duplicate outbound risk.
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  if (code === 131016 || code === 131048 || code === 131056) return true;
  return false;
};

const shouldReleaseDedupeAfterProviderFailure = (status?: number): boolean => {
  const s = Number(status || 0);
  if (!s) return false;
  if (s === 408 || s === 409 || s === 429) return false;
  if (s >= 500) return false;
  return s >= 400 && s < 500;
};

const sendCloudText = async (to: string, text: string): Promise<{ sentId: string | null; providerFailureStatus?: number }> => {
  const settings = getRuntimeSettings();
  const cleanTo = String(to || "").replace(/\D/g, "");
  const cleanText = String(text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

  if (!cleanTo || !/^\d{8,20}$/.test(cleanTo)) {
    bumpHardeningMetric("outbound.invalid_recipient_blocked");
    pushHardeningSignal("outbound_invalid_recipient_blocked", 3, { toLength: cleanTo.length });
    console.warn("[wa-cloud][send] invalid outbound recipient blocked", { toLength: cleanTo.length });
    return { sentId: null };
  }

  if (!cleanText) {
    bumpHardeningMetric("outbound.empty_text_blocked");
    console.warn("[wa-cloud][send] empty outbound text blocked", { to: cleanTo });
    return { sentId: null };
  }

  if (cleanText.length > MAX_INBOUND_TEXT_LENGTH) {
    bumpHardeningMetric("outbound.oversized_text_blocked");
    pushHardeningSignal("outbound_oversized_text_blocked", 3, { size: cleanText.length });
    console.warn("[wa-cloud][send] oversized outbound text blocked", { to: cleanTo, size: cleanText.length });
    return { sentId: null };
  }

  if (!settings.waCloudPhoneNumberId || !settings.waCloudAccessToken) {
    console.error("[wa-cloud][send] missing credentials");
    pushHardeningSignal("outbound_send_missing_credentials", 1, {});
    return { sentId: null };
  }

  const maxAttempts = Math.max(1, Math.min(6, Number(settings.waOutboundRetryMaxAttempts || 3)));
  const retryRequiresIdempotency = resolveManagedReplyRetryRequireIdempotencyKey();
  const allowRetry = !retryRequiresIdempotency;
  const effectiveMaxAttempts = allowRetry ? maxAttempts : 1;
  if (maxAttempts > 1 && !allowRetry) {
    bumpHardeningMetric("outbound.cloud_retry_blocked_without_idempotency_policy");
    pushHardeningSignal("outbound_cloud_retry_blocked_without_idempotency_policy", 3, {
      maxAttempts,
      retryRequiresIdempotency
    });
  }
  let lastError: any = null;

  for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const requestTimeoutMs = resolveOutboundRequestTimeoutMs();
      const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);

      const res = await fetch(`https://graph.facebook.com/v21.0/${settings.waCloudPhoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.waCloudAccessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to: cleanTo, type: "text", text: { body: cleanText } }),
        signal: controller.signal
      }).finally(() => clearTimeout(timeoutHandle));
      const data: any = await res.json().catch(() => ({}));

      if (res.ok) {
        bumpHardeningMetric("outbound.cloud_send_ok");
        return { sentId: data?.messages?.[0]?.id || crypto.randomUUID() };
      }

      const cloudCode = Number(data?.error?.code);
      const retryable = isRetryableCloudFailure(res.status, cloudCode);
      lastError = data?.error?.message || `status ${res.status}`;

      if (!retryable || attempt === effectiveMaxAttempts) {
        if (retryable && !allowRetry) {
          bumpHardeningMetric("outbound.cloud_retry_blocked_missing_idempotency_key");
          pushHardeningSignal("outbound_cloud_retry_blocked_missing_idempotency_key", 3, { status: res.status, cloudCode, attempt });
        }
        bumpHardeningMetric("outbound.cloud_send_failed");
        pushHardeningSignal("outbound_retry_exhausted", 3, { status: res.status, cloudCode });
        console.error("[wa-cloud][send] failed:", lastError, { status: res.status, cloudCode, attempt, maxAttempts: effectiveMaxAttempts, allowRetry });
        return { sentId: null, providerFailureStatus: Number(res.status) || undefined };
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      bumpHardeningMetric("outbound.cloud_retry_attempt");
      if (retryAfterMs && retryAfterMs > 0) bumpHardeningMetric("outbound.cloud_retry_after_header_used");
      pushHardeningSignal("outbound_retry", 8, { status: res.status, cloudCode, attempt, maxAttempts });
      await sleep(computeBackoffMs(attempt, retryAfterMs));
    } catch (e: any) {
      const status = Number(e?.statusCode || e?.status);
      const isAbortTimeout = e?.name === "AbortError";
      const timeoutRetryEnabled = isAbortTimeout ? resolveOutboundRetryOnTimeout() : false;
      const retryable = isAbortTimeout ? timeoutRetryEnabled : isRetryableCloudFailure(status);
      lastError = e?.message || e;

      if (isAbortTimeout) {
        bumpHardeningMetric("outbound.cloud_request_timeout");
        pushHardeningSignal("outbound_cloud_request_timeout", 4, { attempt, timeoutMs: resolveOutboundRequestTimeoutMs() });

        if (!timeoutRetryEnabled) {
          bumpHardeningMetric("outbound.cloud_timeout_not_retried");
          pushHardeningSignal("outbound_cloud_timeout_not_retried", 3, { attempt });
        }
      }

      if (!retryable || attempt === effectiveMaxAttempts) {
        if (retryable && !allowRetry) {
          bumpHardeningMetric("outbound.cloud_retry_blocked_missing_idempotency_key");
          pushHardeningSignal("outbound_cloud_retry_blocked_missing_idempotency_key", 3, {
            status: status || undefined,
            attempt,
            reason: isAbortTimeout ? "timeout" : undefined
          });
        }
        bumpHardeningMetric("outbound.cloud_send_failed");
        pushHardeningSignal("outbound_retry_exhausted", 3, { status: status || undefined, reason: isAbortTimeout ? "timeout" : undefined });
        console.error("[wa-cloud][send] exception:", lastError, { status, attempt, maxAttempts: effectiveMaxAttempts, isAbortTimeout, timeoutRetryEnabled, allowRetry });
        return { sentId: null, providerFailureStatus: status || undefined };
      }

      const retryAfterMs = parseRetryAfterMs(e?.response?.headers?.["retry-after"] || e?.headers?.["retry-after"]);
      bumpHardeningMetric("outbound.cloud_retry_attempt");
      if (retryAfterMs && retryAfterMs > 0) bumpHardeningMetric("outbound.cloud_retry_after_header_used");
      pushHardeningSignal("outbound_retry", 8, { status, attempt, maxAttempts, reason: isAbortTimeout ? "timeout" : undefined });
      await sleep(computeBackoffMs(attempt, retryAfterMs));
    }
  }

  bumpHardeningMetric("outbound.cloud_send_failed");
  console.error("[wa-cloud][send] exhausted retries", { lastError });
  return { sentId: null };
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
    const host = u.hostname.toLowerCase();
    const path = decodeURIComponent(u.pathname || "").replace(/\/+/g, "/");
    return `${host}${path}`.slice(0, 240);
  } catch {
    return input.split("?")[0].split("#")[0].trim().slice(0, 240);
  }
};

const buildOutboundDedupeKey = (
  companyId: number,
  to: string,
  payload: { mode: "text"; text: string } | { mode: "media"; mediaUrl: string; mediaType?: string; caption?: string }
) => {
  const cleanTo = String(to || "").replace(/\D/g, "");
  const semantic = payload.mode === "media"
    ? `media:${String(payload.mediaType || "image").toLowerCase()}:${normalizeMediaUrlForDedupe(payload.mediaUrl)}:${normalizeForDedupe(String(payload.caption || ""))}`
    : `text:${normalizeForDedupe(payload.text)}`;
  const tenant = Math.max(0, Number(companyId) || 0);
  const base = `${tenant}:${cleanTo}:${semantic}`;
  return `wa-out:${crypto.createHash("sha1").update(base).digest("hex")}`;
};

const emitOutgoing = (ticket: any, contact: any, message: any) => { try { const io = getIO(); io.to(`ticket-${ticket.id}`).emit("appMessage", { action: "create", message, ticket, contact }); } catch {} };

const sendManagedReply = async ({ ticket, contact, text }: { ticket: any; contact: any; text: string }) => {
  const cleanText = String(text || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();

  if (!cleanText) {
    bumpHardeningMetric("outbound.empty_text_blocked");
    pushHardeningSignal("outbound_empty_text_blocked", 3, { ticketId: ticket.id, source: "managed_reply" });
    return null;
  }

  const dedupeKey = buildOutboundDedupeKey(ticket.companyId, String(contact.number), { mode: "text", text: cleanText });
  const dedupeTtlSeconds = resolveOutboundDedupeTtlSeconds();
  let shouldSend = true;
  let dedupeReservationMode: "persistent" | "memory" = "persistent";
  try {
    shouldSend = await reserveOutboundDedupe(dedupeKey, dedupeTtlSeconds);
  } catch (dedupeErr: any) {
    bumpHardeningMetric("outbound.dedupe_infra_error");
    pushHardeningSignal("outbound_dedupe_infra_error", 3, { ticketId: ticket.id });

    if (resolveOutboundDedupeFailClosed()) {
      bumpHardeningMetric("outbound.dedupe_fail_closed_blocked");
      pushHardeningSignal("outbound_dedupe_fail_closed_blocked", 2, {
        ticketId: ticket.id,
        source: "managed_reply"
      });
      console.error("[wa-cloud][send] dedupe infra failed; fail-closed blocked managed reply", {
        ticketId: ticket.id,
        dedupeKey,
        error: dedupeErr?.message || String(dedupeErr)
      });
      return null;
    }

    dedupeReservationMode = "memory";
    shouldSend = reserveOutboundDedupeMemory(dedupeKey, dedupeTtlSeconds);
    if (shouldSend) {
      bumpHardeningMetric("outbound.dedupe_memory_reserved");
    } else {
      bumpHardeningMetric("outbound.dedupe_memory_blocked");
      bumpHardeningMetric("outbound.duplicate_blocked");
      pushHardeningSignal("outbound_duplicate_blocked", 5, { ticketId: ticket.id, source: "memory_fallback" });
      console.warn("[wa-cloud][send] duplicate outbound blocked by memory fallback", { ticketId: ticket.id, dedupeKey });
      return null;
    }
    console.error("[wa-cloud][send] dedupe infra failed; using memory fallback", {
      ticketId: ticket.id,
      dedupeKey,
      error: dedupeErr?.message || String(dedupeErr)
    });
  }
  if (!shouldSend) {
    bumpHardeningMetric("outbound.dedupe_db_blocked");
    bumpHardeningMetric("outbound.duplicate_blocked");
    pushHardeningSignal("outbound_duplicate_blocked", 5, { ticketId: ticket.id });
    console.warn("[wa-cloud][send] duplicate outbound blocked", { ticketId: ticket.id, dedupeKey });
    return null;
  }
  bumpHardeningMetric("outbound.dedupe_reserved");
  const sendResult = await sendCloudText(String(contact.number), cleanText);
  if (!sendResult.sentId) {
    bumpHardeningMetric("outbound.provider_send_failed");
    pushHardeningSignal("outbound_provider_send_failed", 4, {
      ticketId: ticket.id,
      providerFailureStatus: sendResult.providerFailureStatus || undefined
    });

    if (shouldReleaseDedupeAfterProviderFailure(sendResult.providerFailureStatus)) {
      if (dedupeReservationMode === "persistent") {
        try {
          await releaseOutboundDedupe(dedupeKey);
          bumpHardeningMetric("outbound.dedupe_released_after_non_retryable_provider_error");
        } catch (releaseErr: any) {
          bumpHardeningMetric("outbound.dedupe_release_failed_after_non_retryable_provider_error");
          pushHardeningSignal("outbound_dedupe_release_failed", 2, {
            ticketId: ticket.id,
            providerFailureStatus: sendResult.providerFailureStatus || undefined
          });
          console.error("[wa-cloud][send] failed to release dedupe key after non-retryable provider error", {
            dedupeKey,
            error: releaseErr?.message || String(releaseErr)
          });
        }
      } else {
        bumpHardeningMetric("outbound.dedupe_release_skipped_memory_mode");
      }
    } else {
      bumpHardeningMetric("outbound.dedupe_retained_after_provider_failure");
    }

    console.error("[wa-cloud][send] outbound not persisted because provider send failed", {
      ticketId: ticket.id,
      contactId: contact.id,
      dedupeKey,
      providerFailureStatus: sendResult.providerFailureStatus
    });
    return null;
  }
  const out = await Message.create({ id: sendResult.sentId, body: cleanText, contactId: contact.id, ticketId: ticket.id, fromMe: true, read: true, ack: 1, mediaType: "chat" } as any);
  emitOutgoing(ticket, contact, out);
  return out;
};
const ensureArchivedTag = async (contactId: number) => { const [tag] = await Tag.findOrCreate({ where: { name: "archivado" }, defaults: { name: "archivado", color: "#6b7280" } }); const exists = await ContactTag.findOne({ where: { contactId, tagId: tag.id } }); if (!exists) await ContactTag.create({ contactId, tagId: tag.id } as any); };
const autoSummaryAndScore = async (ticketId: number, contact: Contact) => {
  const inbound = await Message.findAll({ where: { ticketId, fromMe: false }, order: [["createdAt", "DESC"]], limit: 6 });
  const joined = inbound.map((m: any) => String(m.body || "").trim()).filter(Boolean).reverse().join(" | ");
  if (!joined) return;
  let score = Number((contact as any).lead_score || 0);
  if (/comprar|contratar|precio|plan|quiero|usd|d[oó]lar|departamento|casa/i.test(joined)) score = Math.max(score, 65);
  if (/urgente|ahora|hoy|visita|seña/i.test(joined)) score = Math.max(score, 75);
  if (/gracias|resuelto|listo/i.test(joined)) score = Math.max(score, 40);
  await (contact as any).update({ needs: joined.slice(0, 900), lead_score: Math.min(100, score), updatedAt: new Date() } as any);
};

const isLowSignalMessage = (text: string) => {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (/^[\p{Emoji}\s👍👌👏🙏😂🤣❤❤️]+$/u.test(t)) return true;
  return /^(ok|oka|dale|genial|gracias|joya|perfecto|👍|👌|🙏)$/.test(t);
};

const parseBudget = (text: string): number | null => {
  const m = String(text || "").toLowerCase().match(/(\d{2,3}(?:[\.,]\d{3})+|\d{5,8})\s*(usd|u\$s|d[oó]lares?)/i);
  if (!m) return null;
  return Number(String(m[1]).replace(/\./g, "").replace(/,/g, "")) || null;
};

const isWebhookTimestampAcceptable = (timestamp?: string): boolean => {
  const ts = Number(timestamp || 0);
  if (!ts) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - ts;
  if (age > MAX_WEBHOOK_MESSAGE_AGE_SECONDS) return false;
  if (age < -MAX_WEBHOOK_FUTURE_SKEW_SECONDS) return false;
  return true;
};

const isValidInboundSender = (from: string): boolean => /^\d{8,20}$/.test(String(from || ""));

const isValidInboundMessageId = (messageId: string): boolean => /^[A-Za-z0-9:_\-.]{6,200}$/.test(String(messageId || ""));

const isValidInboundType = (type: string): boolean => ALLOWED_INBOUND_TYPES.has(String(type || "").toLowerCase());

const isInboundTextLengthAcceptable = (body: string): boolean => String(body || "").length <= MAX_INBOUND_TEXT_LENGTH;

const ragLookup = async (companyId: number, text: string, limit = 3) => {
  const q = String(text || "").trim().toLowerCase();
  if (!q) return [] as any[];
  const terms = q.split(/\s+/).filter((w) => w.length >= 4).slice(0, 5);
  const like = `%${q}%`;
  const rows: any[] = await sequelize.query(
    `SELECT c.chunk_text, d.title,
            (CASE WHEN POSITION(LOWER(:q) IN LOWER(c.chunk_text)) > 0 THEN 100 ELSE 0 END
             + ${terms.map((_, i) => `CASE WHEN LOWER(c.chunk_text) LIKE LOWER(:t${i}) THEN 10 ELSE 0 END`).join(" + ") || "0"}) AS score
     FROM kb_chunks c
     JOIN kb_documents d ON d.id = c.document_id
     WHERE d.company_id = :companyId
       AND (LOWER(c.chunk_text) LIKE LOWER(:like) OR LOWER(d.title) LIKE LOWER(:like) ${terms.map((_, i) => `OR LOWER(c.chunk_text) LIKE LOWER(:t${i})`).join(" ")})
     ORDER BY score DESC, c.id DESC
     LIMIT :limit`,
    {
      replacements: {
        companyId,
        q,
        like,
        limit,
        ...Object.fromEntries(terms.map((t, i) => [`t${i}`, `%${t}%`]))
      },
      type: QueryTypes.SELECT
    }
  );
  return rows;
};

const tokkoPropertyHint = async (text: string): Promise<string | null> => {
  const rt = getRuntimeSettings();
  if (!rt.tokkoEnabled || !rt.tokkoAgentSearchEnabled || !rt.tokkoApiKey) return null;
  if (!/departamento|depto|casa|propiedad|ambientes|m2|usd|d[oó]lares?|alquiler|venta/i.test(text)) return null;
  try {
    const base = String(rt.tokkoBaseUrl || "https://www.tokkobroker.com/api/v1").replace(/\/$/, "");
    const path = String(rt.tokkoPropertiesPath || "/property/").startsWith("/") ? String(rt.tokkoPropertiesPath || "/property/") : `/${String(rt.tokkoPropertiesPath || "property/")}`;
    const budget = parseBudget(text);
    const search = encodeURIComponent(String(text).slice(0, 120));
    const url = `${base}${path}?key=${encodeURIComponent(rt.tokkoApiKey)}&search=${search}&limit=3${budget ? `&price_to=${budget}` : ""}`;
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    const list = Array.isArray(data?.objects) ? data.objects : (Array.isArray(data) ? data : []);
    if (!list.length) return "No encontré propiedades exactas en Tokko con ese criterio todavía; si querés te pido zona, ambientes y presupuesto para afinar.";
    const top = list.slice(0, 2).map((p: any) => {
      const title = p?.publication_title || p?.title || p?.address || "Propiedad";
      const price = p?.operations?.[0]?.prices?.[0]?.price || p?.price || "s/p";
      return `• ${String(title).slice(0, 70)} (${price})`;
    }).join("\n");
    return `Encontré opciones en Tokko:\n${top}\nSi querés, te paso más opciones filtradas.`;
  } catch {
    return null;
  }
};

const buildLeadFormContextIntro = (needsRaw: any): string => {
  const raw = String(needsRaw || "").trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const entries = Object.entries(parsed)
        .map(([k, v]) => `${String(k)}: ${String(v ?? "").trim()}`)
        .filter((x) => /\S/.test(x))
        .slice(0, 2);

      const flattened = entries.join(" | ");
      const lotMatch = flattened.match(/lote[^|,.;]*/i);
      if (lotMatch?.[0]) {
        return `¡Genial! Vimos que te interesó ${lotMatch[0].trim()}.`;
      }

      if (flattened) {
        return `¡Genial! Vimos tu formulario (${flattened}).`;
      }
    }
  } catch {
    // ignore json parse errors
  }

  const lotMatch = raw.match(/lote[^\n,.;]*/i);
  if (lotMatch?.[0]) return `¡Genial! Vimos que te interesó ${lotMatch[0].trim()}.`;

  return "¡Genial! Vimos tu formulario y ya tenemos tus datos.";
};

const buildLeadFormFollowup = (needsRaw: any): string => {
  const raw = String(needsRaw || "").toLowerCase();

  if (/inversi[oó]n|invertir|renta|rentabilidad/.test(raw)) {
    return "Si es para inversión, ¿querés que te muestre propiedades con mejor oportunidad y rentabilidad?";
  }

  if (/departamento|depto|departamentos/.test(raw)) {
    return "¿También te interesa ver otros departamentos similares? Te ayudo a encontrarlos.";
  }

  if (/casa|casas/.test(raw)) {
    return "¿Querés que te muestre otras casas parecidas según tu búsqueda?";
  }

  if (/lote|terreno|lotes/.test(raw)) {
    return "¿También te interesa ver otros lotes similares en esta zona o zonas cercanas?";
  }

  return "¿También te interesa ver otras propiedades similares? Si querés, te ayudo a buscarlas ahora.";
};

const getLatestMetaLeadFormHint = async (companyId: number, phoneRaw: string): Promise<string> => {
  const phone = String(phoneRaw || "").replace(/\D/g, "");
  if (!phone) return "";

  try {
    const [row]: any = await sequelize.query(
      `SELECT form_id, payload_json, form_fields_json
       FROM meta_lead_events
       WHERE company_id = :companyId
         AND contact_phone IS NOT NULL
         AND REPLACE(REGEXP_REPLACE(contact_phone, '\\D', '', 'g'), ' ', '') LIKE :phoneLike
       ORDER BY created_at DESC
       LIMIT 1`,
      {
        replacements: { companyId, phoneLike: `%${phone.slice(-10)}%` },
        type: QueryTypes.SELECT
      }
    );

    const candidates: string[] = [];
    if (row?.form_id) candidates.push(String(row.form_id));

    try {
      const p = row?.payload_json ? JSON.parse(String(row.payload_json)) : null;
      const n = p?.form_name || p?.form?.name || p?.name || p?.title;
      if (n) candidates.push(String(n));
    } catch {}

    try {
      const f = row?.form_fields_json ? JSON.parse(String(row.form_fields_json)) : null;
      if (f && typeof f === "object") {
        const flat = JSON.stringify(f);
        if (flat) candidates.push(flat);
      }
    } catch {}

    return candidates.join(" ").toLowerCase().slice(0, 300);
  } catch {
    return "";
  }
};

const aiReplyFor = async (text: string, companyId: number, metaFormHint = ""): Promise<string> => {
  const t = String(text || "").toLowerCase();
  if (isLowSignalMessage(t)) return "";
  if (/hola|buenas|buen día|buen dia/.test(t)) return "¡Hola! 👋 Soy el asistente de Charlott. Contame qué necesitás y te ayudo ahora mismo.";
  if (/precio|plan|costo|cu[aá]nto/.test(t)) return "Perfecto. Te cuento planes y precios según tu necesidad. Si querés, te hago una recomendación rápida en 2 pasos.";
  if (/turno|agenda|cita|horario/.test(t)) return "Genial, te ayudo a agendar. Decime día y franja horaria preferida y lo coordinamos.";
  if (/soporte|error|no funciona|problema/.test(t)) return "Gracias por avisar. Ya te ayudo con soporte. Si querés, pasame captura o detalle del error para resolverlo más rápido.";

  const tokkoQuery = [text, metaFormHint].filter(Boolean).join(" ").trim();
  const tokkoHint = await tokkoPropertyHint(tokkoQuery || text);
  if (tokkoHint) return tokkoHint;

  const rows = await ragLookup(companyId, text, 3);
  if (rows[0]?.chunk_text) {
    const snippet = rows.slice(0, 2).map((r: any) => `• ${String(r.chunk_text || "").slice(0, 180)}`).join("\n");
    return `Te respondo con info de la base:\n${snippet}`;
  }
  return "Entendido 👍 ¿Querés que te ayude con precios, agenda de cita, o soporte?";
};

const runAutonomousAgent = async ({ ticket, contact, incomingText }: { ticket: any; contact: any; incomingText: string }) => {
  const text = String(incomingText || "").trim();
  if (!text || (ticket as any).human_override || (ticket as any).bot_enabled === false) return;
  const low = text.toLowerCase();
  const conversationType = classifyConversation(text);
  await sequelize.query(`INSERT INTO ai_turns (conversation_id, role, content, model, latency_ms, tokens_in, tokens_out, created_at, updated_at) VALUES (NULL, 'user', :content, 'wa-cloud', 0, 0, 0, NOW(), NOW())`, { replacements: { content: text }, type: QueryTypes.INSERT });

  if (/humano|asesor|agente|persona/.test(low)) {
    await ticket.update({ human_override: true, bot_enabled: false, updatedAt: new Date() } as any);
    const transferText = "Perfecto. Te paso con un asesor humano para continuar 🙌";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "manual_handoff", reason: "Cliente pidió humano", guardrailAction: "handoff", responsePreview: transferText });
    const out = await sendManagedReply({ ticket, contact, text: transferText });
    await ticket.update({ lastMessage: transferText, updatedAt: new Date() } as any);
    if (!out) return;
    return;
  }

  if (/gracias|perfecto|listo|resuelto/.test(low) && resolvePolicies()[conversationType]?.allowAutoClose) {
    const closeText = "¡Excelente! Cierro esta conversación por ahora ✅ Si necesitás algo más, escribime y la retomamos enseguida.";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "auto_close", reason: "Cierre positivo detectado", guardrailAction: "close", responsePreview: closeText });
    const out = await sendManagedReply({ ticket, contact, text: closeText });
    await ticket.update({ status: "closed", unreadMessages: 0, lastMessage: closeText, updatedAt: new Date() } as any);
    await ensureArchivedTag(contact.id); await (contact as any).update({ leadStatus: "read", lastInteractionAt: new Date() } as any);
    if (!out) return;
    return;
  }

  const metaFormHint = await getLatestMetaLeadFormHint(ticket.companyId, String((contact as any)?.number || ""));
  const baseReplyCore = await aiReplyFor(text, ticket.companyId, metaFormHint);
  const contactNeedsRaw = String((contact as any)?.needs || "");
  const isMetaFormLead = (() => {
    const n = contactNeedsRaw.toLowerCase();
    const h = String(metaFormHint || "").toLowerCase();
    return n.includes("meta") || n.includes("form") || n.includes("leadgen") || n.includes("lote") || n.startsWith("{") || h.includes("form") || h.includes("lead") || h.includes("meta");
  })();
  const shouldInjectLeadFormContext = isMetaFormLead && /asistente de charlott/i.test(String(ticket.lastMessage || "")) && !/hola|buenas|buen d[ií]a/.test(low);
  const leadFormIntro = shouldInjectLeadFormContext ? buildLeadFormContextIntro(contactNeedsRaw) : "";
  const leadFormFollowup = shouldInjectLeadFormContext
    ? buildLeadFormFollowup(contactNeedsRaw)
    : "";
  const baseReply = [leadFormIntro, baseReplyCore, leadFormFollowup].filter((x) => String(x || "").trim()).join(" ").trim();

  if (!String(baseReply || "").trim()) {
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "no_reply_low_signal", reason: "Mensaje de baja señal", guardrailAction: "silence", responsePreview: "" });
    return;
  }
  const guardrail = await applyGuardrails({ text, reply: baseReply, conversationType });
  if (guardrail.handoff) {
    await ticket.update({ human_override: true, bot_enabled: false, updatedAt: new Date() } as any);
    const txt = "Gracias por tu mensaje. Te paso con un asesor humano para tratar este tema con prioridad.";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "guardrail_handoff", reason: guardrail.reason, guardrailAction: guardrail.action, responsePreview: txt });
    const out = await sendManagedReply({ ticket, contact, text: txt });
    await ticket.update({ lastMessage: txt, updatedAt: new Date() } as any);
    if (!out) return;
    return;
  }

  const reply = guardrail.finalReply || baseReply;
  await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "reply", reason: guardrail.reason, guardrailAction: guardrail.action, responsePreview: reply.slice(0, 240) });
  const out = await sendManagedReply({ ticket, contact, text: reply });
  await ticket.update({ status: ticket.status === "pending" ? "open" : ticket.status, lastMessage: reply, updatedAt: new Date() } as any);
  if (!out) return;
  await autoSummaryAndScore(ticket.id, contact);
};

export const processCloudWebhookPayload = async (payload: MetaWebhookPayload) => {
  const whatsapp = await resolveWhatsapp();
  if (!whatsapp) return { processed: 0, ignored: 0, reason: "no_whatsapp_connection" };

  const envelopeMessages = (payload.entry || []).reduce((acc, entry) => {
    return acc + (entry.changes || []).reduce((inner, change) => inner + (change.value?.messages?.length || 0), 0);
  }, 0);
  if (envelopeMessages > MAX_INBOUND_MESSAGES_PER_PAYLOAD) {
    bumpHardeningMetric("inbound.payload_volume_blocked");
    pushHardeningSignal("inbound_payload_volume_blocked", 2, { envelopeMessages, maxAllowed: MAX_INBOUND_MESSAGES_PER_PAYLOAD });
    console.warn("[wa-cloud][inbound] payload volume blocked", { envelopeMessages, maxAllowed: MAX_INBOUND_MESSAGES_PER_PAYLOAD });
    return { processed: 0, ignored: envelopeMessages, reason: "payload_volume_blocked" };
  }

  let processed = 0;
  let ignored = 0;
  let replayBlockedInPayload = 0;
  const maxReplayBlockedPerPayload = resolveInboundReplayMaxBlocksPerPayload();

  outer: for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const incoming of change.value?.messages || []) {
        const from = String(incoming.from || "").replace(/\D/g, "");
        const body = incoming.text?.body || "";
        const externalMsgId = incoming.id || "";
        const timestamp = Number(incoming.timestamp || 0);
        const type = String(incoming.type || "chat");
        const hasTextBody = type === "text" ? Boolean(String(body || "").trim()) : true;
        const validSender = isValidInboundSender(from);
        const validMessageId = isValidInboundMessageId(externalMsgId);
        const validType = isValidInboundType(type);
        const validTextLength = isInboundTextLengthAcceptable(body);

        if (!from || !externalMsgId || !validSender || !validMessageId || !validType || !isWebhookTimestampAcceptable(incoming.timestamp) || !hasTextBody || !validTextLength) {
          if (!from || !externalMsgId) {
            bumpHardeningMetric("inbound.invalid_envelope_blocked");
            console.warn("[wa-cloud][inbound] invalid envelope blocked", { hasFrom: Boolean(from), hasId: Boolean(externalMsgId) });
          } else if (!validSender) {
            bumpHardeningMetric("inbound.invalid_sender_blocked");
            console.warn("[wa-cloud][inbound] invalid sender blocked", { externalMsgId, fromLength: String(from || "").length });
          } else if (!validMessageId) {
            bumpHardeningMetric("inbound.invalid_message_id_blocked");
            console.warn("[wa-cloud][inbound] invalid message id blocked", { externalMsgIdLength: String(externalMsgId || "").length });
          } else if (!validType) {
            bumpHardeningMetric("inbound.invalid_type_blocked");
            console.warn("[wa-cloud][inbound] unsupported type blocked", { externalMsgId, type });
          } else if (!isWebhookTimestampAcceptable(incoming.timestamp)) {
            bumpHardeningMetric("inbound.stale_or_future_blocked");
            console.warn("[wa-cloud][inbound] stale/future webhook blocked", { externalMsgId, timestamp: incoming.timestamp });
          } else if (!hasTextBody) {
            bumpHardeningMetric("inbound.empty_text_body_blocked");
            console.warn("[wa-cloud][inbound] text message without body blocked", { externalMsgId });
          } else {
            bumpHardeningMetric("inbound.oversized_text_blocked");
            console.warn("[wa-cloud][inbound] oversized text blocked", { externalMsgId, size: String(body || "").length });
          }
          ignored += 1;
          continue;
        }

        const replayKey = buildInboundReplayKey(externalMsgId, from);
        const accepted = await reserveInboundReplay(replayKey, resolveInboundReplayTtlSeconds());
        if (!accepted) {
          replayBlockedInPayload += 1;
          bumpHardeningMetric("inbound.replay_blocked");
          recordInboundDuplicate();
          console.warn("[wa-cloud][inbound] replay blocked", { externalMsgId, from });
          pushHardeningSignal("inbound_replay_blocked", 10, { from });
          ignored += 1;

          if (replayBlockedInPayload >= maxReplayBlockedPerPayload) {
            const remaining = Math.max(0, envelopeMessages - processed - ignored);
            if (remaining > 0) {
              ignored += remaining;
            }
            bumpHardeningMetric("inbound.replay_payload_dropped", 1);
            bumpHardeningMetric("inbound.replay_payload_messages_dropped", remaining);
            pushHardeningSignal("inbound_replay_payload_dropped", 2, {
              replayBlockedInPayload,
              maxReplayBlocked: maxReplayBlockedPerPayload,
              droppedMessages: remaining,
              envelopeMessages
            });
            console.warn("[wa-cloud][inbound] payload dropped after replay flood", {
              replayBlockedInPayload,
              maxReplayBlocked: maxReplayBlockedPerPayload,
              droppedMessages: remaining,
              envelopeMessages
            });
            break outer;
          }
          continue;
        }

        try {
          const exists = await Message.findByPk(externalMsgId);
          if (exists) {
            bumpHardeningMetric("inbound.duplicate_message_id_blocked");
            recordInboundDuplicate();
            ignored += 1;
            continue;
          }
          const contact = await getOrCreateContact(from, whatsapp.companyId);
          const ticket = await getOrCreateTicket(contact.id, whatsapp.id, whatsapp.companyId);
          const createdAt = timestamp ? new Date(timestamp * 1000) : new Date();
          const message = await Message.create({ id: externalMsgId || crypto.randomUUID(), body, contactId: contact.id, ticketId: ticket.id, fromMe: false, read: false, ack: 0, mediaType: incoming.type || "chat", createdAt, updatedAt: createdAt } as any);
          await ticket.update({ lastMessage: body, unreadMessages: (ticket.unreadMessages || 0) + 1, updatedAt: new Date() } as any);
          try { await (contact as any).update({ leadStatus: "unread", lastInteractionAt: new Date() } as any); } catch {}
          recordInboundMessage({ fromMe: false, createdAt });
          const io = getIO(); io.to(`ticket-${ticket.id}`).emit("appMessage", { action: "create", message, ticket, contact }); io.to("notification").emit("notification", { type: "new-message", ticketId: ticket.id, contactName: contact.name });
          try { await runAutonomousAgent({ ticket, contact, incomingText: body }); } catch (agentErr: any) { console.error("[wa-cloud][agent] error:", agentErr?.message || agentErr); }
          bumpHardeningMetric("inbound.processed_ok");
          processed += 1;
        } catch (error) {
          bumpHardeningMetric("inbound.processing_error");
          await releaseInboundReplay(replayKey);
          recordInboundError(error);
          pushHardeningSignal("inbound_processing_error", 4, {});
          console.error("[wa-cloud] error processing inbound:", error);
          ignored += 1;
        }
      }
    }
  }

  return { processed, ignored };
};
