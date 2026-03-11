import crypto from "crypto";
import { Router } from "express";
import { QueryTypes } from "sequelize";
import sequelize from "../database";
import { processCloudWebhookPayload, recordInboundSignatureInvalidBlocked, recordInboundSignatureMissingBlocked, recordInboundSignatureMalformedBlocked, recordInboundSignatureInvalidRateLimited, recordInboundPayloadReplayBlocked, recordInboundPayloadReplayKeyCollisionOrRepeat, recordInboundPayloadReplayKeyReuseByIpDetected, recordInboundPayloadReplayCacheTrimmed, recordInboundPayloadReplayGuardInfraError, recordInboundPayloadReplayGuardMemoryFallbackUsed, recordInboundPayloadReplayGuardFailClosedBlocked, recordInboundPayloadOversizeBlocked, recordInboundInvalidEnvelopeBlocked, recordInboundInvalidContentTypeBlocked, recordInboundForwardedHeaderOversizeBlocked, recordInboundTimestampOutsideAllowedSkewBlocked, recordInboundEventNonceReplayBlocked, getWaHardeningMetrics, getWaHardeningAlertSnapshot } from "../services/WhatsAppCloudServices/ProcessCloudWebhookService";
import { getSendHardeningMetrics, getSendHardeningAlertSnapshot } from "../services/MessageServices/SendMessageService";
import { getIntegrationHardeningMetrics, getIntegrationHardeningAlertSnapshot } from "./integrations/integrationRoutes";
import { getRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";

const whatsappCloudRoutes = Router();

const webhookPayloadReplayCache = new Map<string, number>();
const webhookEventNonceCache = new Map<string, number>();
const webhookInvalidSignatureIpBuckets = new Map<string, number[]>();
const webhookPayloadReplayKeyReuseByIpBuckets = new Map<string, number[]>();

let webhookPayloadReplayTableReady = false;
let webhookPayloadReplayLastPruneAt = 0;
const WEBHOOK_PAYLOAD_REPLAY_PRUNE_INTERVAL_MS = 60 * 1000;

const resolveRawBodyForSignature = (req: any): string => {
  if (typeof req?.rawBody === "string") return req.rawBody;
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody.toString("utf8");
  return JSON.stringify(req?.body || {});
};

const buildWebhookPayloadReplayKey = (req: any): string => {
  const bodyRaw = resolveRawBodyForSignature(req);
  const digest = crypto.createHash("sha256").update(bodyRaw, "utf8").digest("hex");
  const objectType = String(req?.body?.object || "unknown").slice(0, 80);
  const entryCount = Array.isArray(req?.body?.entry) ? req.body.entry.length : 0;

  // hardening: replay identity must be payload-stable, never header-stable.
  // If signatures are missing/rotated (proxy quirks, insecure unsigned mode),
  // including x-hub-signature-256 in the key can let the same payload bypass replay guard.
  return `wa-webhook:${objectType}:${entryCount}:${digest}`;
};

const resolveWebhookPayloadReplayTtlMs = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookPayloadReplayTtlSeconds || 120);
  if (!Number.isFinite(n)) return 120000;
  return Math.max(10000, Math.min(900000, Math.round(n * 1000)));
};

const resolveWebhookPayloadReplayCacheMaxEntries = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookPayloadReplayCacheMaxEntries || 5000);
  if (!Number.isFinite(n)) return 5000;
  return Math.max(100, Math.min(50000, Math.round(n)));
};

const resolveWebhookPayloadReplayFailClosed = (): boolean => {
  const raw = (getRuntimeSettings() as any).waWebhookPayloadReplayFailClosed;
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return true; // secure default
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
};

const resolveWebhookMaxBodyBytes = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookMaxBodyBytes || 262144);
  if (!Number.isFinite(n)) return 262144;
  return Math.max(16 * 1024, Math.min(2 * 1024 * 1024, Math.round(n)));
};

const resolveWebhookSignatureHeaderMaxLength = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookSignatureHeaderMaxLength || 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(80, Math.min(512, Math.round(n)));
};

const resolveWebhookForwardedForHeaderMaxLength = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookForwardedForHeaderMaxLength || 2048);
  if (!Number.isFinite(n)) return 2048;
  return Math.max(256, Math.min(8192, Math.round(n)));
};

const resolveWebhookReplayWindowMs = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookReplayWindowSeconds || 120);
  if (!Number.isFinite(n)) return 120000;
  return Math.max(30000, Math.min(15 * 60 * 1000, Math.round(n * 1000)));
};

const resolveWebhookFutureTimestampSkewMs = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookFutureSkewSeconds || 120);
  if (!Number.isFinite(n)) return 120000;
  return Math.max(5000, Math.min(10 * 60 * 1000, Math.round(n * 1000)));
};

const resolveWebhookEventNonceCacheMaxEntries = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookEventNonceCacheMaxEntries || 20000);
  if (!Number.isFinite(n)) return 20000;
  return Math.max(500, Math.min(200000, Math.round(n)));
};

const isWebhookJsonContentTypeValid = (req: any): boolean => {
  const raw = String(req.get("content-type") || "").trim().toLowerCase();
  if (!raw) return false;
  return raw === "application/json" || raw.startsWith("application/json;");
};

const ensureWebhookPayloadReplayTable = async () => {
  if (webhookPayloadReplayTableReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ai_webhook_payload_replay_guard (id SERIAL PRIMARY KEY, replay_key VARCHAR(220) UNIQUE NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_webhook_payload_replay_guard_key ON ai_webhook_payload_replay_guard(replay_key)`);
  // prune runs cada minuto; mantener created_at indexado evita full scans cuando crece el guard
  await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ai_webhook_payload_replay_guard_created_at ON ai_webhook_payload_replay_guard(created_at)`);
  webhookPayloadReplayTableReady = true;
};

const pruneWebhookPayloadReplayIfDue = async (ttlMs: number) => {
  const now = Date.now();
  if (now - webhookPayloadReplayLastPruneAt < WEBHOOK_PAYLOAD_REPLAY_PRUNE_INTERVAL_MS) return;
  webhookPayloadReplayLastPruneAt = now;
  const ttlSeconds = Math.max(10, Math.round(ttlMs / 1000));
  await sequelize.query(`DELETE FROM ai_webhook_payload_replay_guard WHERE created_at < NOW() - (:ttlSeconds::text || ' seconds')::interval`, {
    replacements: { ttlSeconds },
    type: QueryTypes.DELETE
  });
};

const reserveWebhookPayloadReplayPersistent = async (replayKey: string, ttlMs: number): Promise<boolean> => {
  await ensureWebhookPayloadReplayTable();
  await pruneWebhookPayloadReplayIfDue(ttlMs);
  const rows: any[] = await sequelize.query(
    `INSERT INTO ai_webhook_payload_replay_guard (replay_key, created_at)
     VALUES (:replayKey, NOW())
     ON CONFLICT (replay_key) DO NOTHING
     RETURNING replay_key`,
    { replacements: { replayKey }, type: QueryTypes.SELECT }
  );
  return Boolean(rows[0]?.replay_key);
};

const resolveSignatureInvalidRateLimitWindowMs = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookSignatureInvalidRateLimitWindowSeconds || 60);
  if (!Number.isFinite(n)) return 60000;
  return Math.max(10000, Math.min(15 * 60 * 1000, Math.round(n * 1000)));
};

const resolveSignatureInvalidRateLimitMaxHits = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookSignatureInvalidRateLimitMaxHits || 8);
  if (!Number.isFinite(n)) return 8;
  return Math.max(2, Math.min(200, Math.round(n)));
};

const resolvePayloadReplayKeyReuseWindowMs = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookPayloadReplayKeyReuseWindowSeconds || 600);
  if (!Number.isFinite(n)) return 10 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(60 * 60 * 1000, Math.round(n * 1000)));
};

const resolvePayloadReplayKeyReuseThreshold = (): number => {
  const n = Number((getRuntimeSettings() as any).waWebhookPayloadReplayKeyReuseThreshold || 3);
  if (!Number.isFinite(n)) return 3;
  return Math.max(2, Math.min(50, Math.round(n)));
};

const isValidIpv4 = (ip: string): boolean => {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
};

const normalizeIpToken = (rawIp: string): string => {
  const cleaned = String(rawIp || "").trim().toLowerCase();
  if (!cleaned) return "";

  // Reject obviously ambiguous or malformed forwarded entries.
  if (/\s|"|'|;|\\|\//.test(cleaned)) return "";

  // Bracketed IPv6 with optional port: [2001:db8::1]:443
  const bracketedIpv6 = cleaned.match(/^\[([a-f0-9:]+)\](?::(\d{1,5}))?$/i);
  if (bracketedIpv6) {
    const ip = bracketedIpv6[1];
    const port = bracketedIpv6[2] ? Number(bracketedIpv6[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) return "";
    return ip;
  }

  // IPv4 with optional port.
  const ipv4WithOptionalPort = cleaned.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (ipv4WithOptionalPort) {
    const ip = ipv4WithOptionalPort[1];
    const port = ipv4WithOptionalPort[2] ? Number(ipv4WithOptionalPort[2]) : null;
    if (!isValidIpv4(ip)) return "";
    if (port !== null && (port < 1 || port > 65535)) return "";
    return ip;
  }

  // IPv6-mapped IPv4 form: ::ffff:203.0.113.7
  const ipv6MappedIpv4 = cleaned.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv6MappedIpv4) {
    const ip = ipv6MappedIpv4[1];
    return isValidIpv4(ip) ? ip : "";
  }

  // Plain IPv6 token (no port allowed unless bracketed).
  if (/^[a-f0-9:]+$/i.test(cleaned) && cleaned.includes(":")) {
    return cleaned;
  }

  return "";
};

const pickClientIpFromForwarded = (forwardedHeader: string): string => {
  const tokens = String(forwardedHeader || "")
    .split(",")
    .map((x) => normalizeIpToken(x))
    .filter(Boolean);

  for (const token of tokens) {
    // ignore obvious placeholders/unknown hops
    if (token === "unknown" || token === "-" || token === "null") continue;
    return token;
  }

  return "";
};

const resolveRequesterIp = (req: any): string => {
  const direct = normalizeIpToken(String(req.ip || req.socket?.remoteAddress || ""));
  const forwarded = pickClientIpFromForwarded(String(req.get("x-forwarded-for") || ""));

  // Prefer Express-resolved req.ip when available (respects trust proxy config),
  // fallback to x-forwarded-for only when direct is missing/unknown.
  const candidate = direct && direct !== "unknown" ? direct : (forwarded || "unknown");
  return candidate.slice(0, 120);
};

const shouldRateLimitInvalidSignatureByIp = (req: any): { limited: boolean; ip: string; hits: number; maxHits: number; windowMs: number } => {
  const now = Date.now();
  const windowMs = resolveSignatureInvalidRateLimitWindowMs();
  const maxHits = resolveSignatureInvalidRateLimitMaxHits();
  const ip = resolveRequesterIp(req);

  for (const [key, hits] of webhookInvalidSignatureIpBuckets.entries()) {
    const alive = hits.filter((ts) => now - ts < windowMs);
    if (!alive.length) webhookInvalidSignatureIpBuckets.delete(key);
    else webhookInvalidSignatureIpBuckets.set(key, alive);
  }

  const hits = webhookInvalidSignatureIpBuckets.get(ip) || [];
  const aliveHits = hits.filter((ts) => now - ts < windowMs);
  aliveHits.push(now);
  webhookInvalidSignatureIpBuckets.set(ip, aliveHits);

  return {
    limited: aliveHits.length > maxHits,
    ip,
    hits: aliveHits.length,
    maxHits,
    windowMs
  };
};

const trackPayloadReplayKeyReuseByIp = (req: any): { detected: boolean; ip: string; hits: number; threshold: number; windowMs: number; replayKeyHash: string } => {
  const now = Date.now();
  const windowMs = resolvePayloadReplayKeyReuseWindowMs();
  const threshold = resolvePayloadReplayKeyReuseThreshold();
  const ip = resolveRequesterIp(req);
  const replayKeyHash = crypto.createHash("sha1").update(buildWebhookPayloadReplayKey(req), "utf8").digest("hex");
  const bucketKey = `${ip}:${replayKeyHash}`;

  for (const [key, hits] of webhookPayloadReplayKeyReuseByIpBuckets.entries()) {
    const alive = hits.filter((ts) => now - ts < windowMs);
    if (!alive.length) webhookPayloadReplayKeyReuseByIpBuckets.delete(key);
    else webhookPayloadReplayKeyReuseByIpBuckets.set(key, alive);
  }

  const hits = webhookPayloadReplayKeyReuseByIpBuckets.get(bucketKey) || [];
  const aliveHits = hits.filter((ts) => now - ts < windowMs);
  aliveHits.push(now);
  webhookPayloadReplayKeyReuseByIpBuckets.set(bucketKey, aliveHits);

  return {
    detected: aliveHits.length >= threshold,
    ip,
    hits: aliveHits.length,
    threshold,
    windowMs,
    replayKeyHash
  };
};

const trimWebhookPayloadReplayCache = (maxEntries: number) => {
  if (webhookPayloadReplayCache.size <= maxEntries) return;
  const overflow = webhookPayloadReplayCache.size - maxEntries;
  let removed = 0;
  for (const key of webhookPayloadReplayCache.keys()) {
    webhookPayloadReplayCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
  if (removed > 0) {
    recordInboundPayloadReplayCacheTrimmed(removed, {
      cacheSizeAfterTrim: webhookPayloadReplayCache.size,
      maxEntries
    });
  }
};

const reserveWebhookPayloadReplay = async (req: any): Promise<boolean> => {
  const now = Date.now();
  const ttlMs = resolveWebhookPayloadReplayTtlMs();
  const maxEntries = resolveWebhookPayloadReplayCacheMaxEntries();

  for (const [key, expiresAt] of webhookPayloadReplayCache.entries()) {
    if (expiresAt <= now) webhookPayloadReplayCache.delete(key);
  }

  const replayKey = buildWebhookPayloadReplayKey(req);

  try {
    const accepted = await reserveWebhookPayloadReplayPersistent(replayKey, ttlMs);
    if (accepted) {
      webhookPayloadReplayCache.set(replayKey, now + ttlMs);
      trimWebhookPayloadReplayCache(maxEntries);
    }
    return accepted;
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    recordInboundPayloadReplayGuardInfraError({
      error: errorMessage,
      failClosed: resolveWebhookPayloadReplayFailClosed()
    });

    if (resolveWebhookPayloadReplayFailClosed()) {
      console.error("[wa-hardening] payload replay persistent guard unavailable; fail-closed blocking webhook", {
        error: errorMessage
      });
      throw new Error("payload_replay_guard_unavailable_fail_closed");
    }

    console.error("[wa-hardening] payload replay persistent guard unavailable; using memory fallback", {
      error: errorMessage
    });
    recordInboundPayloadReplayGuardMemoryFallbackUsed({
      failClosed: false,
      error: errorMessage
    });

    const currentExpiry = webhookPayloadReplayCache.get(replayKey) || 0;
    if (currentExpiry > now) return false;

    webhookPayloadReplayCache.set(replayKey, now + ttlMs);
    trimWebhookPayloadReplayCache(maxEntries);
    return true;
  }
};

const parseSha256SignatureDigest = (signatureHeaderRaw: string): string | null => {
  const signatureHeader = String(signatureHeaderRaw || "").trim();
  if (!signatureHeader.startsWith("sha256=")) return null;

  const digest = signatureHeader.slice("sha256=".length).trim().toLowerCase();
  // sha256 digest must be exactly 64 hex chars
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  return digest;
};

const classifySignatureHeader = (signatureHeaderRaw: string): { valid: boolean; reason: "missing" | "malformed" | "ok"; digest: string | null } => {
  const signatureHeader = String(signatureHeaderRaw || "").trim();
  if (!signatureHeader) return { valid: false, reason: "missing", digest: null };
  const digest = parseSha256SignatureDigest(signatureHeader);
  if (!digest) return { valid: false, reason: "malformed", digest: null };
  return { valid: true, reason: "ok", digest };
};

const parseWebhookTimestampMs = (req: any): { ok: boolean; timestampMs?: number; reason?: string } => {
  const candidates = [
    req.get("x-webhook-timestamp"),
    req.get("x-meta-timestamp"),
    req.get("x-request-timestamp"),
    req.get("x-timestamp"),
    req.body?.timestamp,
    req.body?.entry?.[0]?.time
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || String(candidate).trim() === "") continue;
    const raw = String(candidate).trim();

    if (/^\d{10}$/.test(raw)) {
      const sec = Number(raw);
      if (Number.isFinite(sec) && sec > 0) return { ok: true, timestampMs: sec * 1000 };
      return { ok: false, reason: "timestamp_invalid" };
    }

    if (/^\d{13}$/.test(raw)) {
      const ms = Number(raw);
      if (Number.isFinite(ms) && ms > 0) return { ok: true, timestampMs: ms };
      return { ok: false, reason: "timestamp_invalid" };
    }

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return { ok: true, timestampMs: parsed };

    return { ok: false, reason: "timestamp_invalid" };
  }

  return { ok: false, reason: "timestamp_missing" };
};

const validateWebhookTimestampWindow = (req: any): { ok: boolean; reason?: string; ageMs?: number; replayWindowMs: number; futureSkewMs: number } => {
  const parsed = parseWebhookTimestampMs(req);
  const replayWindowMs = resolveWebhookReplayWindowMs();
  const futureSkewMs = resolveWebhookFutureTimestampSkewMs();

  if (!parsed.ok || !parsed.timestampMs) {
    return { ok: false, reason: parsed.reason || "timestamp_missing", replayWindowMs, futureSkewMs };
  }

  const now = Date.now();
  const ageMs = now - parsed.timestampMs;

  if (ageMs > replayWindowMs) {
    return { ok: false, reason: "timestamp_too_old", ageMs, replayWindowMs, futureSkewMs };
  }

  if (ageMs < -futureSkewMs) {
    return { ok: false, reason: "timestamp_future_skew", ageMs, replayWindowMs, futureSkewMs };
  }

  return { ok: true, ageMs, replayWindowMs, futureSkewMs };
};

const extractWebhookEventNonce = (req: any): string => {
  const candidates = [
    req.get("x-meta-event-id"),
    req.get("x-webhook-id"),
    req.get("x-event-id"),
    req.get("x-request-id"),
    req.body?.entry?.[0]?.id,
    req.body?.id
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const clean = String(candidate).trim().toLowerCase().replace(/[^a-z0-9:_\-.]/g, "").slice(0, 160);
    if (clean) return clean;
  }

  return "";
};

const reserveWebhookEventNonce = (req: any): { accepted: boolean; reason?: string; nonce?: string } => {
  const nonce = extractWebhookEventNonce(req);
  if (!nonce) return { accepted: true };

  const now = Date.now();
  const replayWindowMs = resolveWebhookReplayWindowMs();
  const maxEntries = resolveWebhookEventNonceCacheMaxEntries();

  for (const [key, expiresAt] of webhookEventNonceCache.entries()) {
    if (expiresAt <= now) webhookEventNonceCache.delete(key);
  }

  if (webhookEventNonceCache.size > maxEntries) {
    let overflow = webhookEventNonceCache.size - maxEntries;
    for (const key of webhookEventNonceCache.keys()) {
      webhookEventNonceCache.delete(key);
      overflow -= 1;
      if (overflow <= 0) break;
    }
  }

  const key = `wa-event:${nonce}`;
  const expiresAt = webhookEventNonceCache.get(key) || 0;
  if (expiresAt > now) return { accepted: false, reason: "event_nonce_replay", nonce };

  webhookEventNonceCache.set(key, now + replayWindowMs);
  return { accepted: true, nonce };
};

const resolveAllowUnsignedWebhook = (): boolean => {
  const raw = String((getRuntimeSettings() as any).waWebhookAllowUnsigned || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
};

const parseBooleanRuntimeSetting = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return defaultValue;
};

const resolveWebhookSignatureHardeningState = () => {
  const settings = getRuntimeSettings();
  const appSecretConfigured = Boolean(String(settings.waCloudAppSecret || "").trim());
  const allowUnsigned = resolveAllowUnsignedWebhook();
  return {
    appSecretConfigured,
    allowUnsigned,
    insecureUnsignedWebhookAllowed: allowUnsigned
  };
};

const resolveOutboundRetryHardeningState = () => {
  const settings = getRuntimeSettings() as any;
  const retryRequireIdempotencyRaw = String(settings.waOutboundRetryRequireIdempotencyKey ?? "").trim().toLowerCase();
  const retryRequiresIdempotencyKey = retryRequireIdempotencyRaw === ""
    ? true
    : ["1", "true", "yes", "on"].includes(retryRequireIdempotencyRaw);

  const managedRetryRequireIdempotencyRaw = String(settings.waManagedReplyRetryRequireIdempotencyKey ?? "").trim().toLowerCase();
  const managedRetryRequiresIdempotencyKey = managedRetryRequireIdempotencyRaw === ""
    ? retryRequiresIdempotencyKey
    : ["1", "true", "yes", "on"].includes(managedRetryRequireIdempotencyRaw);

  const requireIdempotencyRaw = String(settings.waOutboundRequireIdempotencyKey ?? "").trim().toLowerCase();
  const outboundRequiresIdempotencyKey = requireIdempotencyRaw === ""
    ? true
    : ["1", "true", "yes", "on"].includes(requireIdempotencyRaw);

  const allowRetryWithoutIdempotencyRaw = String(settings.waOutboundAllowRetryWithoutIdempotencyKey ?? "").trim().toLowerCase();
  const allowRetryWithoutIdempotency = ["1", "true", "yes", "on"].includes(allowRetryWithoutIdempotencyRaw);

  const dedupeFailClosed = parseBooleanRuntimeSetting(settings.waOutboundDedupeFailClosed, true);
  const timeoutRetryEnabled = parseBooleanRuntimeSetting(settings.waOutboundRetryOnTimeout, false);

  return {
    retryRequiresIdempotencyKey,
    allowRetryWithoutIdempotency,
    insecureRetryWithoutIdempotencyAllowed: !retryRequiresIdempotencyKey || allowRetryWithoutIdempotency,
    managedRetryRequiresIdempotencyKey,
    insecureManagedRetryWithoutIdempotencyAllowed: !managedRetryRequiresIdempotencyKey,
    outboundRequiresIdempotencyKey,
    insecureOutboundWithoutIdempotencyAllowed: !outboundRequiresIdempotencyKey,
    dedupeFailClosed,
    insecureDedupeFailOpen: !dedupeFailClosed,
    timeoutRetryEnabled,
    timeoutRetryRequiresIdempotencyKey: timeoutRetryEnabled && retryRequiresIdempotencyKey && !allowRetryWithoutIdempotency,
    timeoutRetryAllowsWithoutIdempotency: timeoutRetryEnabled && (!retryRequiresIdempotencyKey || allowRetryWithoutIdempotency)
  };
};

const isWebhookSignatureValid = (req: any, preclassified?: { valid: boolean; digest: string | null }): boolean => {
  const settings = getRuntimeSettings();
  const appSecret = String(settings.waCloudAppSecret || "").trim();
  if (!appSecret) return resolveAllowUnsignedWebhook();

  const incomingDigest = preclassified?.valid
    ? String(preclassified.digest || "")
    : parseSha256SignatureDigest(String(req.get("x-hub-signature-256") || ""));
  if (!incomingDigest) return false;

  const rawBody = resolveRawBodyForSignature(req);
  const expectedDigest = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const incoming = Buffer.from(incomingDigest, "hex");
  const expected = Buffer.from(expectedDigest, "hex");

  if (incoming.length !== expected.length) return false;
  return crypto.timingSafeEqual(incoming, expected);
};

const validateEnvelope = (req: any): { ok: boolean; reason?: string; entryCount?: number } => {
  const payload = req?.body || {};
  if (payload.object !== "whatsapp_business_account") return { ok: false, reason: "invalid_object" };
  if (!Array.isArray(payload.entry)) return { ok: false, reason: "entry_not_array" };
  if (payload.entry.length < 1) return { ok: false, reason: "entry_empty", entryCount: 0 };

  const hasAnyChange = payload.entry.some((entry: any) => Array.isArray(entry?.changes) && entry.changes.length > 0);
  if (!hasAnyChange) return { ok: false, reason: "changes_missing", entryCount: payload.entry.length };

  return { ok: true, entryCount: payload.entry.length };
};

const timingSafeTokenEquals = (expectedRaw: unknown, candidateRaw: unknown): boolean => {
  const expected = String(expectedRaw || "").trim();
  const candidate = String(candidateRaw || "").trim();
  if (!expected || !candidate) return false;

  const expectedBuf = Buffer.from(expected, "utf8");
  const candidateBuf = Buffer.from(candidate, "utf8");
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
};

const hasValidHardeningToken = (req: any): boolean => {
  const expected = String(getRuntimeSettings().waCloudVerifyToken || "").trim();
  if (!expected) return false;

  const candidate = String(
    req.get("x-hardening-token")
      || req.query?.token
      || req.query?.verify_token
      || ""
  ).trim();

  return timingSafeTokenEquals(expected, candidate);
};

const CRITICAL_HARDENING_SIGNALS = new Set([
  "outbound_retry_exhausted",
  "outbound_wbot_retry_exhausted",
  "outbound_dedupe_fail_closed_blocked",
  "outbound_integration_retry_blocked_missing_idempotency_key",
  "outbound_integration_retry_idempotency_key_required_blocked", // backward-compatible signal name from integrationRoutes
  "outbound_integration_idempotency_key_missing_blocked",
  "outbound_integration_idempotency_key_payload_conflict_blocked",
  "outbound_integration_idempotency_key_required_blocked", // backward-compatible signal name from integrationRoutes
  "inbound_signature_invalid_blocked",
  "inbound_payload_replay_blocked"
]);

const resolveHardeningSignalCount = (entry: any): number => {
  const inWindow = Number(entry?.inWindow);
  if (Number.isFinite(inWindow)) return inWindow;
  const count = Number(entry?.count);
  if (Number.isFinite(count)) return count;
  return 0;
};

const buildHardeningHealth = (inboundAlerts: any, outboundAlerts: any, integrationAlerts?: any) => {
  const pendingAlerts = [
    ...(Array.isArray(inboundAlerts?.pendingAlerts) ? inboundAlerts.pendingAlerts : []),
    ...(Array.isArray(outboundAlerts?.pendingAlerts) ? outboundAlerts.pendingAlerts : []),
    ...(Array.isArray(integrationAlerts?.pendingAlerts) ? integrationAlerts.pendingAlerts : [])
  ];

  const pendingAlertCount = pendingAlerts.length;
  const hasCriticalSignal = pendingAlerts.some((entry) => CRITICAL_HARDENING_SIGNALS.has(String(entry?.signal || "")));
  const highVolumeSignal = pendingAlerts.some((entry) => resolveHardeningSignalCount(entry) >= 8);

  const status = hasCriticalSignal || highVolumeSignal
    ? "critical"
    : pendingAlertCount > 0
      ? "warn"
      : "ok";

  return {
    status,
    pendingAlertCount,
    hasCriticalSignal,
    highVolumeSignal
  };
};

const readCounter = (counters: Record<string, any> | undefined, key: string): number => {
  const value = Number(counters?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
};

const readAlertInWindow = (alertsSnapshot: any, signal: string): number => {
  const pending = Array.isArray(alertsSnapshot?.pendingAlerts) ? alertsSnapshot.pendingAlerts : [];
  const hit = pending.find((item: any) => String(item?.signal || "") === signal);
  const value = Number(hit?.inWindow || 0);
  return Number.isFinite(value) ? value : 0;
};

const buildHardeningSummary = (inbound: any, outbound: any, integrationApi: any, health: any, inboundAlertsSnapshot?: any) => {
  const inboundCounters = inbound?.counters || {};
  const outboundCounters = outbound?.counters || {};
  const integrationApiCounters = integrationApi?.counters || {};

  const inboundSignatureInvalidInWindow10m = readAlertInWindow(inboundAlertsSnapshot, "inbound_signature_invalid_blocked");
  const inboundPayloadReplayInWindow10m = readAlertInWindow(inboundAlertsSnapshot, "inbound_payload_replay_blocked")
    + readAlertInWindow(inboundAlertsSnapshot, "inbound_replay_blocked");
  const inboundSpoofingPressureCombinedInWindow10m = inboundSignatureInvalidInWindow10m + inboundPayloadReplayInWindow10m;
  const inboundSpoofingPressureThreshold = 10;
  const inboundSpoofingPressureMinSignature = 4;
  const inboundSpoofingPressureMinReplay = 3;
  const inboundSpoofingPressureActive = inboundSpoofingPressureCombinedInWindow10m >= inboundSpoofingPressureThreshold
    && inboundSignatureInvalidInWindow10m >= inboundSpoofingPressureMinSignature
    && inboundPayloadReplayInWindow10m >= inboundSpoofingPressureMinReplay;

  const inboundReplayGuardInfraErrorsInWindow10m = readAlertInWindow(inboundAlertsSnapshot, "inbound_payload_replay_guard_infra_error");
  const inboundReplayGuardMemoryFallbackInWindow10m = readAlertInWindow(inboundAlertsSnapshot, "inbound_payload_replay_guard_memory_fallback_used");
  const inboundReplayGuardInfraPressureCombinedInWindow10m = inboundReplayGuardInfraErrorsInWindow10m + inboundReplayGuardMemoryFallbackInWindow10m;
  const inboundReplayGuardInfraPressureThreshold = 3;
  const inboundReplayGuardInfraPressureActive = inboundReplayGuardInfraPressureCombinedInWindow10m >= inboundReplayGuardInfraPressureThreshold;

  const idempotencyKeyUsed = readCounter(outboundCounters, "outbound.idempotency_key_used");
  const missingIdempotencyKey = readCounter(outboundCounters, "outbound.idempotency_key_missing");
  const idempotencyObservedTotal = idempotencyKeyUsed + missingIdempotencyKey;
  const idempotencyCoveragePct = idempotencyObservedTotal > 0
    ? Math.round((idempotencyKeyUsed / idempotencyObservedTotal) * 100)
    : null;

  const retryBlockedNoIdempotencyManagedReplies = readCounter(inboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
    + readCounter(inboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key");

  const retryBlockedUnknownTransportNoIdempotencyManagedReplies = readCounter(inboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key");

  const integrationReplayGuardReservationConflict = readCounter(integrationApiCounters, "outbound.replay_guard_reservation_conflict");
  const integrationReplayGuardReservationConflictOutcomeReplayed = readCounter(integrationApiCounters, "outbound.replay_guard_reservation_conflict_outcome.replayed");
  const integrationReplayGuardReservationConflictOutcomeProcessing = readCounter(integrationApiCounters, "outbound.replay_guard_reservation_conflict_outcome.processing");
  const integrationReplayGuardReservationObserved = integrationReplayGuardReservationConflict
    + readCounter(integrationApiCounters, "outbound.send_attempt_accepted");
  const integrationReplayGuardReservationConflictRate = integrationReplayGuardReservationObserved > 0
    ? Number((integrationReplayGuardReservationConflict / integrationReplayGuardReservationObserved).toFixed(4))
    : 0;

  const summary = {
    status: String(health?.status || "ok"),
    outbound: {
      duplicateBlocked: readCounter(outboundCounters, "outbound.duplicate_blocked"),
      idempotencyKeyUsed,
      missingIdempotencyKey,
      idempotencyObservedTotal,
      idempotencyCoveragePct,
      missingIdempotencyKeyBlocked: readCounter(outboundCounters, "outbound.missing_idempotency_key_blocked"),
      idempotencyKeyInvalidCharsBlocked: readCounter(outboundCounters, "outbound.idempotency_key_invalid_chars_blocked"),
      idempotencyKeyTooLongBlocked: readCounter(outboundCounters, "outbound.idempotency_key_too_long_blocked"),
      idempotencyKeyTooShortBlocked: readCounter(outboundCounters, "outbound.idempotency_key_too_short_blocked"),
      idempotencyKeyTooWeakBlocked: readCounter(outboundCounters, "outbound.idempotency_key_too_weak_blocked"),
      idempotencyKeyTimestampOnlyBlocked: readCounter(outboundCounters, "outbound.idempotency_key_timestamp_only_blocked"),
      idempotencyKeyPayloadConflictBlocked: readCounter(outboundCounters, "outbound.idempotency_key_payload_conflict_blocked"),
      retryBlockedNoIdempotencyKey: readCounter(outboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
        + readCounter(outboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key")
        + retryBlockedNoIdempotencyManagedReplies,
      retryBlockedNoIdempotencyKeyManagedReplies: retryBlockedNoIdempotencyManagedReplies,
      retryBlockedUnknownTransportNoIdempotencyKey: readCounter(outboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key")
        + retryBlockedUnknownTransportNoIdempotencyManagedReplies,
      retryBlockedUnknownTransportNoIdempotencyKeyManagedReplies: retryBlockedUnknownTransportNoIdempotencyManagedReplies,
      retryExhaustedAlerts: readCounter(outboundCounters, "alert.outbound_retry_exhausted")
        + readCounter(outboundCounters, "alert.outbound_wbot_retry_exhausted"),
      providerConflictBlocked: readCounter(outboundCounters, "outbound.provider_conflict_blocked"),
      providerConflictBlockedCloud: readCounter(outboundCounters, "outbound.provider_conflict_blocked.cloud"),
      providerConflictBlockedWbot: readCounter(outboundCounters, "outbound.provider_conflict_blocked.wbot"),
      dedupeInfraErrors: readCounter(outboundCounters, "outbound.dedupe_infra_error"),
      dedupeFailClosedBlocked: readCounter(outboundCounters, "outbound.dedupe_fail_closed_blocked"),
      dedupeEmergencyReserved: readCounter(outboundCounters, "outbound.dedupe_emergency_reserved"),
      dedupeEmergencyDuplicateBlocked: readCounter(outboundCounters, "outbound.dedupe_emergency_duplicate_blocked"),
      dedupeEmergencyTrimmed: readCounter(outboundCounters, "outbound.dedupe_emergency_trimmed"),
      managedReplyDedupeMemoryReserved: readCounter(inboundCounters, "outbound.dedupe_memory_reserved"),
      managedReplyDedupeMemoryDuplicateBlocked: readCounter(inboundCounters, "outbound.dedupe_memory_blocked"),
      dedupeReleaseFailedAfterNonRetryableProviderError: readCounter(outboundCounters, "outbound.dedupe_release_failed_after_non_retryable_provider_error"),
      dedupeReleasedAfterNonRetryableProviderErrorMemoryMode: readCounter(outboundCounters, "outbound.dedupe_released_after_non_retryable_provider_error_memory_mode")
        + readCounter(outboundCounters, "outbound.dedupe_released_after_non_retryable_provider_error_emergency_mode"),
      dedupeReleaseNotFoundAfterNonRetryableProviderErrorMemoryMode: readCounter(outboundCounters, "outbound.dedupe_release_not_found_after_non_retryable_provider_error_memory_mode")
        + readCounter(outboundCounters, "outbound.dedupe_release_not_found_after_non_retryable_provider_error_emergency_mode"),
      duplicateBlockedByMode: {
        text: readCounter(outboundCounters, "outbound.duplicate_blocked_mode.text"),
        template: readCounter(outboundCounters, "outbound.duplicate_blocked_mode.template"),
        media: readCounter(outboundCounters, "outbound.duplicate_blocked_mode.media")
      },
      dedupeReservedByMode: {
        text: readCounter(outboundCounters, "outbound.dedupe_reserved_mode.text"),
        template: readCounter(outboundCounters, "outbound.dedupe_reserved_mode.template"),
        media: readCounter(outboundCounters, "outbound.dedupe_reserved_mode.media")
      }
    },
    inbound: {
      signatureInvalidBlocked: readCounter(inboundCounters, "inbound.signature_invalid_blocked"),
      signatureMissingBlocked: readCounter(inboundCounters, "inbound.signature_missing_blocked"),
      signatureMalformedBlocked: readCounter(inboundCounters, "inbound.signature_malformed_blocked"),
      signatureInvalidRateLimited: readCounter(inboundCounters, "inbound.signature_invalid_rate_limited"),
      invalidEnvelopeBlocked: readCounter(inboundCounters, "inbound.invalid_envelope_blocked"),
      invalidContentTypeBlocked: readCounter(inboundCounters, "inbound.invalid_content_type_blocked"),
      forwardedHeaderOversizeBlocked: readCounter(inboundCounters, "inbound.forwarded_header_oversize_blocked"),
      payloadReplayBlocked: readCounter(inboundCounters, "inbound.payload_replay_blocked"),
      eventNonceReplayBlocked: readCounter(inboundCounters, "inbound.event_nonce_replay_blocked"),
      payloadReplayKeyCollisionOrRepeat: readCounter(inboundCounters, "inbound.payload_replay_key_collision_or_repeat"),
      payloadReplayKeyReuseByIpDetected: readCounter(inboundCounters, "inbound.payload_replay_key_reuse_by_ip_detected"),
      payloadReplayGuardInfraErrors: readCounter(inboundCounters, "inbound.payload_replay_guard_infra_error"),
      payloadReplayGuardMemoryFallbackUsed: readCounter(inboundCounters, "inbound.payload_replay_guard_memory_fallback_used"),
      payloadReplayGuardFailClosedBlocked: readCounter(inboundCounters, "inbound.payload_replay_guard_fail_closed_blocked"),
      payloadSizeBlocked: readCounter(inboundCounters, "inbound.payload_size_blocked"),
      payloadVolumeBlocked: readCounter(inboundCounters, "inbound.payload_volume_blocked"),
      replayMessageBlocked: readCounter(inboundCounters, "inbound.replay_blocked"),
      timestampOutsideAllowedSkewBlocked: readCounter(inboundCounters, "inbound.timestamp_outside_allowed_skew_blocked"),
      timestampTooOldBlocked: readCounter(inboundCounters, "inbound.timestamp_too_old_blocked"),
      timestampFutureSkewBlocked: readCounter(inboundCounters, "inbound.timestamp_future_skew_blocked"),
      spoofingPressure10m: {
        active: inboundSpoofingPressureActive,
        signatureInvalidInWindow: inboundSignatureInvalidInWindow10m,
        replayInWindow: inboundPayloadReplayInWindow10m,
        combinedInWindow: inboundSpoofingPressureCombinedInWindow10m,
        threshold: inboundSpoofingPressureThreshold,
        minSignature: inboundSpoofingPressureMinSignature,
        minReplay: inboundSpoofingPressureMinReplay
      },
      replayGuardInfraPressure10m: {
        active: inboundReplayGuardInfraPressureActive,
        infraErrorInWindow: inboundReplayGuardInfraErrorsInWindow10m,
        memoryFallbackInWindow: inboundReplayGuardMemoryFallbackInWindow10m,
        combinedInWindow: inboundReplayGuardInfraPressureCombinedInWindow10m,
        threshold: inboundReplayGuardInfraPressureThreshold
      }
    },
    integrationApi: {
      sendAttemptAccepted: readCounter(integrationApiCounters, "outbound.send_attempt_accepted"),
      sendAttemptFailed: readCounter(integrationApiCounters, "outbound.send_attempt_failed"),
      idempotencyKeyInvalidFormatBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_format_blocked"),
      idempotencyKeyInvalidCharsBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_chars_blocked"),
      idempotencyKeyMissingBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_required_blocked"),
      retryBlockedMissingIdempotencyKey: readCounter(integrationApiCounters, "outbound.retry_idempotency_key_required_blocked"),
      idempotencyKeyTooWeakBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_too_weak_blocked"),
      idempotencyKeyPlaceholderBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_placeholder_blocked"),
      idempotencyKeyTimestampOnlyBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_timestamp_only_blocked"),
      idempotencyKeyPayloadConflictBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_payload_conflict_blocked"),
      replayGuardMemoryFallbackUsed: readCounter(integrationApiCounters, "outbound.replay_guard_memory_fallback_used"),
      replayGuardReservationConflict: integrationReplayGuardReservationConflict,
      replayGuardReservationConflictOutcomeReplayed: integrationReplayGuardReservationConflictOutcomeReplayed,
      replayGuardReservationConflictOutcomeProcessing: integrationReplayGuardReservationConflictOutcomeProcessing,
      replayGuardReservationObserved: integrationReplayGuardReservationObserved,
      replayGuardReservationConflictRate: integrationReplayGuardReservationConflictRate,
      missingIdempotencyFingerprintReplayBlocked: readCounter(integrationApiCounters, "outbound.missing_idempotency_fingerprint_replay_blocked"),
      missingIdempotencyFingerprintGuardReserved: readCounter(integrationApiCounters, "outbound.missing_idempotency_fingerprint_guard_reserved"),
      retryWithoutIdempotencyFingerprintGuarded: readCounter(integrationApiCounters, "outbound.retry_without_idempotency_fingerprint_guarded")
    }
  };

  const recommendations: string[] = [];
  if (summary.outbound.retryBlockedNoIdempotencyKey > 0) {
    recommendations.push("Agregar Idempotency-Key en clientes outbound para habilitar reintentos seguros.");
  }
  if (summary.outbound.retryBlockedUnknownTransportNoIdempotencyKey > 0) {
    recommendations.push("Se bloquearon reintentos por errores de transporte ambiguos sin Idempotency-Key: instrumentar claves idempotentes en clientes para cubrir cortes de red/timeouts intermedios.");
  }
  if (summary.outbound.providerConflictBlocked > 0) {
    if (summary.outbound.providerConflictBlockedCloud > 0) {
      recommendations.push("Cloud API devolvió conflictos outbound (409/códigos de colisión): verificar reuse de Idempotency-Key por envío lógico y evitar retries paralelos del mismo mensaje.");
    }
    if (summary.outbound.providerConflictBlockedWbot > 0) {
      recommendations.push("wbot reportó conflictos outbound con riesgo de duplicado: serializar envíos por destinatario/ticket y aplicar backoff con jitter para evitar carreras de reintento.");
    }
    if (!summary.outbound.providerConflictBlockedCloud && !summary.outbound.providerConflictBlockedWbot) {
      recommendations.push("El proveedor devolvió conflictos outbound (409/códigos de colisión): revisar reuso de Idempotency-Key y dedupe de cliente para evitar duplicados lógicos.");
    }
  }
  if (summary.outbound.missingIdempotencyKey > 0) {
    recommendations.push("Hay envíos outbound sin Idempotency-Key: instrumentar clientes para reducir riesgo de duplicados en retries/timeouts.");
  }
  if (summary.outbound.idempotencyObservedTotal >= 20
    && typeof summary.outbound.idempotencyCoveragePct === "number"
    && summary.outbound.idempotencyCoveragePct < 95) {
    recommendations.push(`Cobertura de Idempotency-Key baja (${summary.outbound.idempotencyCoveragePct}% sobre ${summary.outbound.idempotencyObservedTotal} envíos observados): elevar adopción para reintentos seguros.`);
  }
  if (summary.outbound.missingIdempotencyKeyBlocked > 0) {
    recommendations.push("Se bloquearon envíos por falta de Idempotency-Key (modo estricto): actualizar clientes para enviar clave idempotente por request.");
  }
  if (summary.outbound.idempotencyKeyInvalidCharsBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key con caracteres inválidos: aplicar allowlist [a-zA-Z0-9:_-.] en cliente antes de enviar.");
  }
  if (summary.outbound.idempotencyKeyTooLongBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key demasiado largo: limitar la clave a 120 caracteres y evitar concatenaciones no acotadas.");
  }
  if (summary.outbound.idempotencyKeyTooShortBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key demasiado corto: usar UUID/ULID o longitud mínima configurada para evitar colisiones.");
  }
  if (summary.outbound.idempotencyKeyTooWeakBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key débil: usar claves con entropía real (UUID/ULID) y al menos 2 caracteres distintos.");
  }
  if (summary.outbound.idempotencyKeyTimestampOnlyBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key timestamp-only: evitar timestamps crudos y usar UUID/ULID para reducir colisiones y reintentos duplicados.");
  }
  if (summary.outbound.idempotencyKeyPayloadConflictBlocked > 0) {
    recommendations.push("Se detectó reuso de Idempotency-Key con payload distinto en outbound directo: generar una clave única por envío lógico y no reciclarla entre contenidos diferentes.");
  }
  if (summary.integrationApi.idempotencyKeyInvalidFormatBlocked > 0 || summary.integrationApi.idempotencyKeyInvalidCharsBlocked > 0) {
    recommendations.push("La Integration API rechazó Idempotency-Key por formato inválido: validar allowlist [a-zA-Z0-9:_-.], longitud y normalización en el cliente antes de enviar.");
  }
  if (summary.integrationApi.idempotencyKeyMissingBlocked > 0) {
    recommendations.push("La Integration API bloqueó envíos por falta de Idempotency-Key (modo estricto): enviar clave idempotente por request desde el cliente.");
  }
  if (summary.integrationApi.retryBlockedMissingIdempotencyKey > 0) {
    recommendations.push("La Integration API bloqueó reintentos por falta de Idempotency-Key: enviar clave idempotente fuerte por request para habilitar retry seguro en errores transitorios.");
  }
  if (summary.integrationApi.idempotencyKeyTooWeakBlocked > 0) {
    recommendations.push("La Integration API bloqueó Idempotency-Key débil: usar UUID/ULID o claves con entropía real para evitar colisiones entre requests.");
  }
  if (summary.integrationApi.idempotencyKeyTimestampOnlyBlocked > 0) {
    recommendations.push("La Integration API bloqueó Idempotency-Key timestamp-only: evitar timestamps crudos y generar claves únicas con entropía real por request.");
  }
  if (summary.integrationApi.idempotencyKeyPayloadConflictBlocked > 0) {
    recommendations.push("La Integration API detectó reutilización de Idempotency-Key con payload distinto: asegurar una clave única por intento lógico y no reusar la misma clave con otro contenido.");
  }
  if (summary.integrationApi.sendAttemptFailed > 0) {
    recommendations.push("Hubo fallos reales en envíos outbound de Integration API: revisar logs de provider/credenciales y aplicar retry del lado cliente con Idempotency-Key fuerte para evitar duplicados.");
  }
  if (summary.integrationApi.replayGuardMemoryFallbackUsed > 0) {
    recommendations.push("Integration API está usando fallback en memoria del replay guard outbound: revisar disponibilidad DB/migraciones de ai_integration_outbound_replay_guard para recuperar persistencia cross-restart.");
  }
  if (summary.integrationApi.missingIdempotencyFingerprintReplayBlocked > 0) {
    recommendations.push("Se bloquearon retries sin Idempotency-Key por fingerprint fallback (409): persistir/reusar x-idempotency-key por envío lógico para evitar bloqueos por duplicado en reintentos legítimos.");
  }
  if (summary.integrationApi.retryWithoutIdempotencyFingerprintGuarded > 0) {
    recommendations.push("Se observaron retries sin Idempotency-Key protegidos por guard fallback: migrar clientes a idempotency key estable por request para reducir dependencia del fingerprint temporal (TTL). ");
  }
  if (summary.integrationApi.replayGuardReservationConflict > 0) {
    recommendations.push("Se detectaron conflictos de reserva en replay guard outbound (carreras por misma Idempotency-Key): aplicar single-flight por clave idempotente y agregar jitter corto en retries para evitar stampede de workers.");
    if (summary.integrationApi.replayGuardReservationConflictOutcomeProcessing > summary.integrationApi.replayGuardReservationConflictOutcomeReplayed) {
      recommendations.push("En conflictos de reserva predomina outcome=processing (in-flight): serializar más fuerte por Idempotency-Key y ensanchar jitter/backoff para reducir contención concurrente.");
    }
  }
  if (summary.outbound.duplicateBlockedByMode.template > 0) {
    recommendations.push("Hay duplicados outbound bloqueados en templates: revisar reintentos del flujo de primer contacto/campañas y propagar Idempotency-Key por envío.");
  }
  if (summary.inbound.signatureMissingBlocked > 0) {
    recommendations.push("Se bloquearon webhooks sin x-hub-signature-256: validar forwarding del header en proxy/WAF antes de la app.");
  }
  if (summary.inbound.signatureMalformedBlocked > 0) {
    recommendations.push("Se bloquearon webhooks con x-hub-signature-256 malformado: verificar formato sha256=<hex64> y normalización de cabeceras en edge.");
  }
  if (summary.inbound.signatureInvalidBlocked > 0) {
    recommendations.push("Revisar origen/IP de firmas inválidas y aplicar allowlist en reverse proxy/WAF.");
  }
  if (summary.inbound.spoofingPressure10m?.active) {
    recommendations.push("Presión de spoofing/replay activa en 10m: endurecer allowlist IP + rate-limit por IP/firma inválida y revisar correlación con intentos de replay.");
  }
  if (summary.inbound.signatureInvalidRateLimited > 0) {
    recommendations.push("Se activó rate-limit por firmas inválidas: bloquear IPs ofensivas en edge (WAF/proxy) y revisar intentos de spoofing.");
  }
  if (summary.inbound.signatureInvalidBlocked >= 5 && (summary.inbound.payloadReplayBlocked + summary.inbound.replayMessageBlocked) >= 3) {
    recommendations.push("Correlación alta entre firmas inválidas y replay inbound: tratar como presión de spoofing/replay, endurecer allowlist IP en edge y verificar drift/reintentos del proveedor para separar ataque de degradación operativa.");
  }
  if (summary.inbound.invalidEnvelopeBlocked > 0) {
    recommendations.push("Verificar productores del webhook: se detectaron envelopes inválidos bloqueados por hardening.");
  }
  if (summary.inbound.invalidContentTypeBlocked > 0) {
    recommendations.push("Se bloquearon webhooks con Content-Type no JSON: corregir cliente/proxy para enviar application/json y evitar rechazos 415.");
  }
  if (summary.inbound.forwardedHeaderOversizeBlocked > 0) {
    recommendations.push("Se bloquearon webhooks con x-forwarded-for sobredimensionado: limitar tamaño del header en edge/proxy para reducir superficie de spoofing y presión de parsing.");
  }
  if (summary.inbound.timestampOutsideAllowedSkewBlocked > 0) {
    recommendations.push(`Se bloquearon webhooks por timestamp fuera de ventana (${summary.inbound.timestampOutsideAllowedSkewBlocked}): revisar sincronización NTP/reloj en productores y verificar reintentos tardíos.`);
  }
  if (summary.inbound.timestampTooOldBlocked > 0) {
    recommendations.push("Se detectaron webhooks demasiado viejos: revisar colas/reintentos con alta latencia y acotar expiración de entregas aguas arriba.");
  }
  if (summary.inbound.timestampFutureSkewBlocked > 0) {
    recommendations.push("Se detectaron webhooks con timestamp en el futuro: validar drift de reloj/NTP en origen o manipulación de payload.");
  }
  if (summary.inbound.payloadReplayBlocked > 0 || summary.inbound.replayMessageBlocked > 0) {
    recommendations.push("Investigar origen de replay (reintentos de proveedor o duplicados de integración).");
  }
  if (summary.inbound.eventNonceReplayBlocked > 0) {
    recommendations.push("Se bloquearon replays por reutilización de event-id/nonce en webhook: revisar productor/proxy para evitar reenvío del mismo evento y validar reintentos con nuevos ids.");
  }
  if (summary.inbound.payloadReplayKeyCollisionOrRepeat > 0) {
    recommendations.push("Se detectaron replays bloqueados por clave estable de payload (`payload_replay_key_collision_or_repeat`): revisar productores que reenvían el mismo body y confirmar estrategia de idempotencia/retry upstream.");
  }
  if (summary.inbound.payloadReplayKeyReuseByIpDetected > 0) {
    recommendations.push("Se detectó reutilización anómala de payload_replay_key por IP en ventana corta: endurecer filtrado en edge (WAF/proxy), revisar origen del tráfico y aplicar bloqueo temporal por IP/fingerprint cuando corresponda.");
  }
  if (summary.inbound.payloadReplayGuardInfraErrors > 0) {
    recommendations.push("Se detectaron errores de infraestructura en el guard de replay de payload: revisar disponibilidad DB/migraciones para recuperar persistencia.");
  }
  if (summary.inbound.replayGuardInfraPressure10m?.active) {
    recommendations.push("Presión de errores/fallback del replay guard en 10m: priorizar salud de DB (latencia, locks, conectividad, migraciones) para separar degradación operativa de intentos de replay legítimos/ataque.");
  }
  if (summary.inbound.payloadReplayGuardMemoryFallbackUsed > 0) {
    recommendations.push("El guard de replay inbound está operando en fallback de memoria: restaurar persistencia (DB) para evitar huecos de replay entre reinicios/réplicas.");
  }
  if (summary.inbound.payloadReplayGuardFailClosedBlocked > 0) {
    recommendations.push("Hubo webhooks bloqueados por fail-closed del guard de replay: restaurar conectividad/health de DB para evitar pérdida de eventos inbound legítimos.");
  }
  if (summary.inbound.payloadSizeBlocked > 0 || summary.inbound.payloadVolumeBlocked > 0) {
    recommendations.push("Se bloquearon payloads por tamaño/volumen: revisar productores y ajustar batching para evitar drops legítimos.");
  }
  if (summary.outbound.dedupeInfraErrors > 0) {
    recommendations.push("Corregir disponibilidad de ai_outbound_dedupe (DB/migraciones) para evitar fallback de dedupe en memoria.");
  }
  if (summary.outbound.dedupeEmergencyReserved > 0) {
    recommendations.push("Se están aceptando envíos con dedupe de emergencia en memoria: recuperar guard persistente para evitar riesgo de duplicados entre réplicas/restarts.");
  }
  if (summary.outbound.dedupeEmergencyDuplicateBlocked > 0) {
    recommendations.push("Ya hubo duplicados bloqueados en modo de emergencia (memoria): priorizar restaurar ai_outbound_dedupe persistente y revisar salud DB para evitar ventanas entre reinicios.");
  }
  if (summary.outbound.dedupeEmergencyTrimmed > 0) {
    recommendations.push("El dedupe de emergencia recortó entries por límite de memoria: subir waOutboundDedupeMemoryMaxEntries o recuperar guard persistente para no perder cobertura.");
  }
  if (summary.outbound.managedReplyDedupeMemoryReserved > 0) {
    recommendations.push("Respuestas gestionadas están usando dedupe en memoria (fallback): recuperar guard persistente ai_outbound_dedupe para mantener cobertura anti-duplicados entre reinicios/réplicas.");
  }
  if (summary.outbound.managedReplyDedupeMemoryDuplicateBlocked > 0) {
    recommendations.push("Se bloquearon duplicados de respuestas gestionadas en dedupe de memoria: priorizar restaurar persistencia de ai_outbound_dedupe para evitar ventanas anti-duplicados fuera del proceso.");
  }
  if (summary.outbound.dedupeReleaseFailedAfterNonRetryableProviderError > 0) {
    recommendations.push("Falló la liberación de dedupe tras errores no reintentables del proveedor: revisar permisos/disponibilidad DB para evitar bloqueos falsos en próximos envíos.");
  }
  if (summary.outbound.dedupeReleaseNotFoundAfterNonRetryableProviderErrorMemoryMode > 0) {
    recommendations.push("En modo dedupe de emergencia (memoria), hubo liberaciones no encontradas tras error no reintentable: revisar TTL/trim para minimizar falsos bloqueos y recuperar guard persistente cuanto antes.");
  }
  if (summary.outbound.dedupeFailClosedBlocked > 0) {
    recommendations.push("Hay envíos bloqueados por fail-closed de dedupe: revisar conectividad DB antes de reintentar outbound.");
  }

  return {
    ...summary,
    recommendations
  };
};

const buildDerivedHardeningAlerts = (inbound: any, outbound: any, integrationApi?: any, inboundAlertSnapshot?: any) => {
  const inboundCounters = inbound?.counters || {};
  const outboundCounters = outbound?.counters || {};
  const integrationApiCounters = integrationApi?.counters || {};
  const inboundPendingAlerts = Array.isArray(inboundAlertSnapshot?.pendingAlerts)
    ? inboundAlertSnapshot.pendingAlerts
    : [];

  const idempotencyKeyUsed = readCounter(outboundCounters, "outbound.idempotency_key_used");
  const missingIdempotencyKey = readCounter(outboundCounters, "outbound.idempotency_key_missing");
  const idempotencyObservedTotal = idempotencyKeyUsed + missingIdempotencyKey;
  const idempotencyCoveragePct = idempotencyObservedTotal > 0
    ? Math.round((idempotencyKeyUsed / idempotencyObservedTotal) * 100)
    : null;

  const runtimeInboundAlerts: any[] = [];
  const runtimeOutboundAlerts: any[] = [];

  if (typeof idempotencyCoveragePct === "number"
    && idempotencyObservedTotal >= 20
    && idempotencyCoveragePct < 95) {
    runtimeOutboundAlerts.push({
      signal: "outbound_idempotency_coverage_low",
      threshold: 95,
      inWindow: idempotencyCoveragePct,
      remaining: 0,
      severity: idempotencyCoveragePct < 80 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        observed: idempotencyObservedTotal,
        used: idempotencyKeyUsed,
        missing: missingIdempotencyKey
      }
    });
  }

  const replayBlocked = readCounter(inboundCounters, "inbound.payload_replay_blocked")
    + readCounter(inboundCounters, "inbound.replay_blocked");
  const eventNonceReplayBlocked = readCounter(inboundCounters, "inbound.event_nonce_replay_blocked");
  if (replayBlocked >= 5) {
    runtimeInboundAlerts.push({
      signal: "inbound_replay_spike",
      threshold: 5,
      inWindow: replayBlocked,
      remaining: 0,
      severity: replayBlocked >= 15 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  if (eventNonceReplayBlocked >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_event_nonce_replay_blocked_spike",
      threshold: 2,
      inWindow: eventNonceReplayBlocked,
      remaining: 0,
      severity: eventNonceReplayBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundPayloadReplayKeyCollisionOrRepeat = readCounter(inboundCounters, "inbound.payload_replay_key_collision_or_repeat");
  if (inboundPayloadReplayKeyCollisionOrRepeat >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_replay_key_collision_or_repeat_spike",
      threshold: 2,
      inWindow: inboundPayloadReplayKeyCollisionOrRepeat,
      remaining: 0,
      severity: inboundPayloadReplayKeyCollisionOrRepeat >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "inbound.payload_replay_key_collision_or_repeat",
        replayBlocked
      }
    });
  }

  const inboundPayloadReplayKeyReuseByIpDetected = readCounter(inboundCounters, "inbound.payload_replay_key_reuse_by_ip_detected");
  if (inboundPayloadReplayKeyReuseByIpDetected >= 1) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_replay_key_reuse_by_ip_detected",
      threshold: 1,
      inWindow: inboundPayloadReplayKeyReuseByIpDetected,
      remaining: 0,
      severity: inboundPayloadReplayKeyReuseByIpDetected >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "inbound.payload_replay_key_reuse_by_ip_detected",
        replayBlocked,
        payloadReplayKeyCollisionOrRepeat: inboundPayloadReplayKeyCollisionOrRepeat
      }
    });
  }

  const inboundSignatureInvalidBlocked = readCounter(inboundCounters, "inbound.signature_invalid_blocked");
  if (inboundSignatureInvalidBlocked >= 5) {
    runtimeInboundAlerts.push({
      signal: "inbound_signature_invalid_spike",
      threshold: 5,
      inWindow: inboundSignatureInvalidBlocked,
      remaining: 0,
      severity: inboundSignatureInvalidBlocked >= 20 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const signatureInvalidWindowHits = inboundPendingAlerts
    .filter((alert: any) => String(alert?.signal || "") === "inbound_signature_invalid_blocked")
    .reduce((acc: number, alert: any) => acc + Math.max(0, Number(alert?.inWindow) || 0), 0);
  const replayBlockedWindowHits = inboundPendingAlerts
    .filter((alert: any) => {
      const signal = String(alert?.signal || "");
      return signal === "inbound_payload_replay_blocked" || signal === "inbound_replay_blocked";
    })
    .reduce((acc: number, alert: any) => acc + Math.max(0, Number(alert?.inWindow) || 0), 0);

  const spoofingPressureObserved = signatureInvalidWindowHits + replayBlockedWindowHits;
  if (signatureInvalidWindowHits >= 4 && replayBlockedWindowHits >= 3 && spoofingPressureObserved >= 10) {
    runtimeInboundAlerts.push({
      signal: "inbound_signature_replay_correlation_pressure_high",
      threshold: 10,
      inWindow: spoofingPressureObserved,
      remaining: 0,
      severity: spoofingPressureObserved >= 20 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        windowMs: 10 * 60 * 1000,
        signatureInvalidBlockedInWindow: signatureInvalidWindowHits,
        replayBlockedInWindow: replayBlockedWindowHits,
        signatureInvalidBlockedTotal: inboundSignatureInvalidBlocked,
        replayBlockedTotal: replayBlocked
      }
    });
  }

  const inboundSignatureMissingBlocked = readCounter(inboundCounters, "inbound.signature_missing_blocked");
  if (inboundSignatureMissingBlocked >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_signature_missing_blocked_spike",
      threshold: 2,
      inWindow: inboundSignatureMissingBlocked,
      remaining: 0,
      severity: inboundSignatureMissingBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundSignatureMalformedBlocked = readCounter(inboundCounters, "inbound.signature_malformed_blocked");
  if (inboundSignatureMalformedBlocked >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_signature_malformed_blocked_spike",
      threshold: 2,
      inWindow: inboundSignatureMalformedBlocked,
      remaining: 0,
      severity: inboundSignatureMalformedBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundSignatureInvalidRateLimited = readCounter(inboundCounters, "inbound.signature_invalid_rate_limited");
  if (inboundSignatureInvalidRateLimited >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_signature_invalid_rate_limited_spike",
      threshold: 2,
      inWindow: inboundSignatureInvalidRateLimited,
      remaining: 0,
      severity: inboundSignatureInvalidRateLimited >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundPayloadSizeBlocked = readCounter(inboundCounters, "inbound.payload_size_blocked");
  if (inboundPayloadSizeBlocked >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_size_blocked_spike",
      threshold: 2,
      inWindow: inboundPayloadSizeBlocked,
      remaining: 0,
      severity: inboundPayloadSizeBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundReplayGuardFailClosedBlocked = readCounter(inboundCounters, "inbound.payload_replay_guard_fail_closed_blocked");
  if (inboundReplayGuardFailClosedBlocked >= 1) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_replay_guard_fail_closed_blocked",
      threshold: 1,
      inWindow: inboundReplayGuardFailClosedBlocked,
      remaining: 0,
      severity: inboundReplayGuardFailClosedBlocked >= 5 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundReplayGuardInfraErrors = readCounter(inboundCounters, "inbound.payload_replay_guard_infra_error");
  if (inboundReplayGuardInfraErrors >= 1) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_replay_guard_infra_error",
      threshold: 1,
      inWindow: inboundReplayGuardInfraErrors,
      remaining: 0,
      severity: inboundReplayGuardInfraErrors >= 3 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundReplayGuardInfraErrorsInWindow = inboundPendingAlerts
    .filter((alert: any) => String(alert?.signal || "") === "inbound_payload_replay_guard_infra_error")
    .reduce((acc: number, alert: any) => acc + Math.max(0, Number(alert?.inWindow) || 0), 0);
  const inboundReplayGuardMemoryFallbackInWindow = inboundPendingAlerts
    .filter((alert: any) => String(alert?.signal || "") === "inbound_payload_replay_guard_memory_fallback_used")
    .reduce((acc: number, alert: any) => acc + Math.max(0, Number(alert?.inWindow) || 0), 0);
  const inboundReplayGuardInfraPressureInWindow = inboundReplayGuardInfraErrorsInWindow + inboundReplayGuardMemoryFallbackInWindow;

  if (inboundReplayGuardInfraPressureInWindow >= 3) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_replay_guard_infra_error_pressure_high",
      threshold: 3,
      inWindow: inboundReplayGuardInfraPressureInWindow,
      remaining: 0,
      severity: inboundReplayGuardInfraPressureInWindow >= 8 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        windowMs: 10 * 60 * 1000,
        infraErrorInWindow: inboundReplayGuardInfraErrorsInWindow,
        memoryFallbackInWindow: inboundReplayGuardMemoryFallbackInWindow,
        infraErrorTotal: inboundReplayGuardInfraErrors,
        memoryFallbackTotal: readCounter(inboundCounters, "inbound.payload_replay_guard_memory_fallback_used")
      }
    });
  }

  const inboundReplayGuardMemoryFallbackUsed = readCounter(inboundCounters, "inbound.payload_replay_guard_memory_fallback_used");
  if (inboundReplayGuardMemoryFallbackUsed >= 1) {
    runtimeInboundAlerts.push({
      signal: "inbound_payload_replay_guard_memory_fallback_used",
      threshold: 1,
      inWindow: inboundReplayGuardMemoryFallbackUsed,
      remaining: 0,
      severity: inboundReplayGuardMemoryFallbackUsed >= 3 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundInvalidEnvelopeBlocked = readCounter(inboundCounters, "inbound.invalid_envelope_blocked");
  if (inboundInvalidEnvelopeBlocked >= 3) {
    runtimeInboundAlerts.push({
      signal: "inbound_invalid_envelope_blocked_spike",
      threshold: 3,
      inWindow: inboundInvalidEnvelopeBlocked,
      remaining: 0,
      severity: inboundInvalidEnvelopeBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundInvalidContentTypeBlocked = readCounter(inboundCounters, "inbound.invalid_content_type_blocked");
  if (inboundInvalidContentTypeBlocked >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_invalid_content_type_blocked_spike",
      threshold: 2,
      inWindow: inboundInvalidContentTypeBlocked,
      remaining: 0,
      severity: inboundInvalidContentTypeBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundForwardedHeaderOversizeBlocked = readCounter(inboundCounters, "inbound.forwarded_header_oversize_blocked");
  if (inboundForwardedHeaderOversizeBlocked >= 2) {
    runtimeInboundAlerts.push({
      signal: "inbound_forwarded_header_oversize_blocked_spike",
      threshold: 2,
      inWindow: inboundForwardedHeaderOversizeBlocked,
      remaining: 0,
      severity: inboundForwardedHeaderOversizeBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const inboundTimestampOutsideAllowedSkewBlocked = readCounter(inboundCounters, "inbound.timestamp_outside_allowed_skew_blocked");
  if (inboundTimestampOutsideAllowedSkewBlocked >= 3) {
    runtimeInboundAlerts.push({
      signal: "inbound_timestamp_outside_allowed_skew_spike",
      threshold: 3,
      inWindow: inboundTimestampOutsideAllowedSkewBlocked,
      remaining: 0,
      severity: inboundTimestampOutsideAllowedSkewBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        tooOld: readCounter(inboundCounters, "inbound.timestamp_too_old_blocked"),
        futureSkew: readCounter(inboundCounters, "inbound.timestamp_future_skew_blocked")
      }
    });
  }

  const outboundRetryBlockedMissingIdempotencyManagedReplies = readCounter(inboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
    + readCounter(inboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key");

  const outboundRetryBlockedUnknownTransportNoIdempotencyManagedReplies = readCounter(inboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key");

  const outboundTimeoutNotRetried = readCounter(outboundCounters, "outbound.cloud_timeout_not_retried");
  if (outboundTimeoutNotRetried >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_timeout_not_retried_spike",
      threshold: 3,
      inWindow: outboundTimeoutNotRetried,
      remaining: 0,
      severity: outboundTimeoutNotRetried >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        cloudRequestTimeout: readCounter(outboundCounters, "outbound.cloud_request_timeout"),
        retryBlockedMissingIdempotencyKey: readCounter(outboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
          + readCounter(outboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key")
          + outboundRetryBlockedMissingIdempotencyManagedReplies,
        retryBlockedMissingIdempotencyKeyManagedReplies: outboundRetryBlockedMissingIdempotencyManagedReplies
      }
    });
  }

  const outboundRetryBlockedMissingIdempotency = readCounter(outboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
    + readCounter(outboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key")
    + outboundRetryBlockedMissingIdempotencyManagedReplies;
  if (outboundRetryBlockedMissingIdempotency >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_retry_blocked_missing_idempotency_spike",
      threshold: 3,
      inWindow: outboundRetryBlockedMissingIdempotency,
      remaining: 0,
      severity: outboundRetryBlockedMissingIdempotency >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        direct: readCounter(outboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
          + readCounter(outboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key"),
        managedReplies: outboundRetryBlockedMissingIdempotencyManagedReplies
      }
    });
  }

  const outboundRetryBlockedUnknownTransportNoIdempotency = readCounter(outboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key")
    + outboundRetryBlockedUnknownTransportNoIdempotencyManagedReplies;
  if (outboundRetryBlockedUnknownTransportNoIdempotency >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_retry_blocked_unknown_transport_without_idempotency_spike",
      threshold: 2,
      inWindow: outboundRetryBlockedUnknownTransportNoIdempotency,
      remaining: 0,
      severity: outboundRetryBlockedUnknownTransportNoIdempotency >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        direct: readCounter(outboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key"),
        managedReplies: outboundRetryBlockedUnknownTransportNoIdempotencyManagedReplies
      }
    });
  }

  const outboundProviderConflictBlocked = readCounter(outboundCounters, "outbound.provider_conflict_blocked");
  if (outboundProviderConflictBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_provider_conflict_blocked_spike",
      threshold: 2,
      inWindow: outboundProviderConflictBlocked,
      remaining: 0,
      severity: outboundProviderConflictBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.provider_conflict_blocked",
        cloud: readCounter(outboundCounters, "outbound.provider_conflict_blocked.cloud"),
        wbot: readCounter(outboundCounters, "outbound.provider_conflict_blocked.wbot")
      }
    });
  }

  const outboundIdempotencyKeyInvalidCharsBlocked = readCounter(outboundCounters, "outbound.idempotency_key_invalid_chars_blocked");
  if (outboundIdempotencyKeyInvalidCharsBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_idempotency_key_invalid_chars_spike",
      threshold: 2,
      inWindow: outboundIdempotencyKeyInvalidCharsBlocked,
      remaining: 0,
      severity: outboundIdempotencyKeyInvalidCharsBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundIdempotencyKeyTooLongBlocked = readCounter(outboundCounters, "outbound.idempotency_key_too_long_blocked");
  if (outboundIdempotencyKeyTooLongBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_idempotency_key_too_long_spike",
      threshold: 2,
      inWindow: outboundIdempotencyKeyTooLongBlocked,
      remaining: 0,
      severity: outboundIdempotencyKeyTooLongBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundIdempotencyKeyTooShortBlocked = readCounter(outboundCounters, "outbound.idempotency_key_too_short_blocked");
  if (outboundIdempotencyKeyTooShortBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_idempotency_key_too_short_spike",
      threshold: 2,
      inWindow: outboundIdempotencyKeyTooShortBlocked,
      remaining: 0,
      severity: outboundIdempotencyKeyTooShortBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundTimestampOnlyIdempotencyBlocked = readCounter(outboundCounters, "outbound.idempotency_key_timestamp_only_blocked");
  if (outboundTimestampOnlyIdempotencyBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_idempotency_key_timestamp_only_blocked_spike",
      threshold: 2,
      inWindow: outboundTimestampOnlyIdempotencyBlocked,
      remaining: 0,
      severity: outboundTimestampOnlyIdempotencyBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundIdempotencyPayloadConflictBlocked = readCounter(outboundCounters, "outbound.idempotency_key_payload_conflict_blocked");
  if (outboundIdempotencyPayloadConflictBlocked >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_idempotency_key_payload_conflict_blocked",
      threshold: 1,
      inWindow: outboundIdempotencyPayloadConflictBlocked,
      remaining: 0,
      severity: outboundIdempotencyPayloadConflictBlocked >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_payload_conflict_blocked"
      }
    });
  }

  const integrationIdempotencyPlaceholderBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_placeholder_blocked");
  if (integrationIdempotencyPlaceholderBlocked >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_placeholder_blocked_spike",
      threshold: 1,
      inWindow: integrationIdempotencyPlaceholderBlocked,
      remaining: 0,
      severity: integrationIdempotencyPlaceholderBlocked >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_placeholder_blocked"
      }
    });
  }

  const integrationWeakIdempotencyBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_too_weak_blocked")
    + integrationIdempotencyPlaceholderBlocked;
  if (integrationWeakIdempotencyBlocked >= 3) {
    runtimeOutboundAlerts.push({
      signal: "integration_api_idempotency_key_too_weak_spike",
      threshold: 3,
      inWindow: integrationWeakIdempotencyBlocked,
      remaining: 0,
      severity: integrationWeakIdempotencyBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metrics: [
          "outbound.idempotency_key_too_weak_blocked",
          "outbound.idempotency_key_placeholder_blocked"
        ],
        tooWeak: readCounter(integrationApiCounters, "outbound.idempotency_key_too_weak_blocked"),
        placeholder: integrationIdempotencyPlaceholderBlocked
      }
    });
  }

  const integrationTimestampOnlyIdempotencyBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_timestamp_only_blocked");
  if (integrationTimestampOnlyIdempotencyBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "integration_api_idempotency_key_timestamp_only_spike",
      threshold: 2,
      inWindow: integrationTimestampOnlyIdempotencyBlocked,
      remaining: 0,
      severity: integrationTimestampOnlyIdempotencyBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_timestamp_only_blocked"
      }
    });
  }

  const integrationIdempotencyMalformedBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_format_blocked")
    + readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_chars_blocked")
    + readCounter(integrationApiCounters, "outbound.idempotency_key_too_long_blocked");
  if (integrationIdempotencyMalformedBlocked >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_malformed_spike",
      threshold: 3,
      inWindow: integrationIdempotencyMalformedBlocked,
      remaining: 0,
      severity: integrationIdempotencyMalformedBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metrics: [
          "outbound.idempotency_key_invalid_format_blocked",
          "outbound.idempotency_key_invalid_chars_blocked",
          "outbound.idempotency_key_too_long_blocked"
        ]
      }
    });
  }

  const integrationIdempotencyInvalidCharsBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_chars_blocked");
  if (integrationIdempotencyInvalidCharsBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_invalid_chars_spike",
      threshold: 2,
      inWindow: integrationIdempotencyInvalidCharsBlocked,
      remaining: 0,
      severity: integrationIdempotencyInvalidCharsBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_invalid_chars_blocked"
      }
    });
  }

  const integrationIdempotencyTooLongBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_too_long_blocked");
  if (integrationIdempotencyTooLongBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_too_long_spike",
      threshold: 2,
      inWindow: integrationIdempotencyTooLongBlocked,
      remaining: 0,
      severity: integrationIdempotencyTooLongBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_too_long_blocked"
      }
    });
  }

  const integrationIdempotencyTooShortBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_too_short_blocked");
  if (integrationIdempotencyTooShortBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_too_short_spike",
      threshold: 2,
      inWindow: integrationIdempotencyTooShortBlocked,
      remaining: 0,
      severity: integrationIdempotencyTooShortBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_too_short_blocked"
      }
    });
  }

  const integrationIdempotencyMismatchBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_mismatch_blocked");
  if (integrationIdempotencyMismatchBlocked >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_mismatch_spike",
      threshold: 3,
      inWindow: integrationIdempotencyMismatchBlocked,
      remaining: 0,
      severity: integrationIdempotencyMismatchBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_mismatch_blocked"
      }
    });
  }

  const integrationIdempotencyPayloadConflictBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_payload_conflict_blocked");
  if (integrationIdempotencyPayloadConflictBlocked >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_payload_conflict_blocked",
      threshold: 1,
      inWindow: integrationIdempotencyPayloadConflictBlocked,
      remaining: 0,
      severity: integrationIdempotencyPayloadConflictBlocked >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_payload_conflict_blocked"
      }
    });
  }

  const integrationReplayGuardMemoryFallbackUsed = readCounter(integrationApiCounters, "outbound.replay_guard_memory_fallback_used");
  if (integrationReplayGuardMemoryFallbackUsed >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_replay_guard_memory_fallback_used",
      threshold: 1,
      inWindow: integrationReplayGuardMemoryFallbackUsed,
      remaining: 0,
      severity: integrationReplayGuardMemoryFallbackUsed >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.replay_guard_memory_fallback_used"
      }
    });
  }

  const integrationSendAttemptFailed = readCounter(integrationApiCounters, "outbound.send_attempt_failed");
  if (integrationSendAttemptFailed >= 4) {
    runtimeOutboundAlerts.push({
      signal: "integration_api_send_attempt_failed_spike",
      threshold: 4,
      inWindow: integrationSendAttemptFailed,
      remaining: 0,
      severity: integrationSendAttemptFailed >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.send_attempt_failed"
      }
    });
  }

  const integrationSendAttemptAccepted = readCounter(integrationApiCounters, "outbound.send_attempt_accepted");
  const integrationSendAttemptObserved = integrationSendAttemptAccepted + integrationSendAttemptFailed;
  const integrationSendAttemptFailureRate = integrationSendAttemptObserved > 0
    ? Number((integrationSendAttemptFailed / integrationSendAttemptObserved).toFixed(4))
    : 0;

  const integrationReplayGuardReservationConflict = readCounter(integrationApiCounters, "outbound.replay_guard_reservation_conflict");
  const integrationReplayGuardReservationConflictOutcomeReplayed = readCounter(integrationApiCounters, "outbound.replay_guard_reservation_conflict_outcome.replayed");
  const integrationReplayGuardReservationConflictOutcomeProcessing = readCounter(integrationApiCounters, "outbound.replay_guard_reservation_conflict_outcome.processing");
  const integrationReplayGuardReservationObserved = integrationReplayGuardReservationConflict + integrationSendAttemptAccepted;
  const integrationReplayGuardReservationConflictRate = integrationReplayGuardReservationObserved > 0
    ? Number((integrationReplayGuardReservationConflict / integrationReplayGuardReservationObserved).toFixed(4))
    : 0;

  if (integrationReplayGuardReservationObserved >= 20 && integrationReplayGuardReservationConflictRate >= 0.15) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_replay_guard_reservation_conflict_rate_high",
      threshold: 0.15,
      inWindow: integrationReplayGuardReservationConflictRate,
      remaining: 0,
      severity: integrationReplayGuardReservationConflictRate >= 0.3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        observed: integrationReplayGuardReservationObserved,
        conflicts: integrationReplayGuardReservationConflict,
        accepted: integrationSendAttemptAccepted,
        conflictRate: integrationReplayGuardReservationConflictRate,
        outcomeReplayed: integrationReplayGuardReservationConflictOutcomeReplayed,
        outcomeProcessing: integrationReplayGuardReservationConflictOutcomeProcessing,
        metric: "outbound.replay_guard_reservation_conflict",
        outcomeMetrics: [
          "outbound.replay_guard_reservation_conflict_outcome.replayed",
          "outbound.replay_guard_reservation_conflict_outcome.processing"
        ]
      }
    });
  }

  if (integrationSendAttemptObserved >= 20 && integrationSendAttemptFailureRate >= 0.1) {
    runtimeOutboundAlerts.push({
      signal: "integration_api_send_failure_rate_high",
      threshold: 0.1,
      inWindow: integrationSendAttemptFailureRate,
      remaining: 0,
      severity: integrationSendAttemptFailureRate >= 0.2 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        observed: integrationSendAttemptObserved,
        failed: integrationSendAttemptFailed,
        accepted: integrationSendAttemptAccepted,
        failureRate: integrationSendAttemptFailureRate
      }
    });
  }

  const integrationIdempotencyMissingBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_required_blocked");
  if (integrationIdempotencyMissingBlocked >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_missing_blocked",
      threshold: 1,
      inWindow: integrationIdempotencyMissingBlocked,
      remaining: 0,
      severity: integrationIdempotencyMissingBlocked >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_required_blocked"
      }
    });
  }

  const integrationRetryBlockedMissingIdempotency = readCounter(integrationApiCounters, "outbound.retry_idempotency_key_required_blocked");
  if (integrationRetryBlockedMissingIdempotency >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_retry_blocked_missing_idempotency_key",
      threshold: 1,
      inWindow: integrationRetryBlockedMissingIdempotency,
      remaining: 0,
      severity: integrationRetryBlockedMissingIdempotency >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.retry_idempotency_key_required_blocked"
      }
    });
  }

  const integrationMissingIdempotencyFingerprintReplayBlocked = readCounter(integrationApiCounters, "outbound.missing_idempotency_fingerprint_replay_blocked");
  if (integrationMissingIdempotencyFingerprintReplayBlocked >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_missing_idempotency_fingerprint_replay_blocked",
      threshold: 1,
      inWindow: integrationMissingIdempotencyFingerprintReplayBlocked,
      remaining: 0,
      severity: integrationMissingIdempotencyFingerprintReplayBlocked >= 3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.missing_idempotency_fingerprint_replay_blocked"
      }
    });
  }

  const integrationRetryWithoutIdempotencyFingerprintGuarded = readCounter(integrationApiCounters, "outbound.retry_without_idempotency_fingerprint_guarded");
  const integrationRetryWithoutIdempotencyFingerprintObserved = integrationRetryWithoutIdempotencyFingerprintGuarded + integrationSendAttemptAccepted;
  const integrationRetryWithoutIdempotencyFingerprintGuardedRate = integrationRetryWithoutIdempotencyFingerprintObserved > 0
    ? Number((integrationRetryWithoutIdempotencyFingerprintGuarded / integrationRetryWithoutIdempotencyFingerprintObserved).toFixed(4))
    : 0;
  if (integrationRetryWithoutIdempotencyFingerprintObserved >= 20 && integrationRetryWithoutIdempotencyFingerprintGuardedRate >= 0.15) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_retry_without_idempotency_fingerprint_guarded_rate_high",
      threshold: 0.15,
      inWindow: integrationRetryWithoutIdempotencyFingerprintGuardedRate,
      remaining: 0,
      severity: integrationRetryWithoutIdempotencyFingerprintGuardedRate >= 0.3 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        observed: integrationRetryWithoutIdempotencyFingerprintObserved,
        guarded: integrationRetryWithoutIdempotencyFingerprintGuarded,
        accepted: integrationSendAttemptAccepted,
        rate: integrationRetryWithoutIdempotencyFingerprintGuardedRate,
        metrics: [
          "outbound.retry_without_idempotency_fingerprint_guarded",
          "outbound.send_attempt_accepted"
        ]
      }
    });
  }

  const integrationIdempotencyTooWeakBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_too_weak_blocked");
  if (integrationIdempotencyTooWeakBlocked >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_integration_idempotency_key_too_weak_spike",
      threshold: 3,
      inWindow: integrationIdempotencyTooWeakBlocked,
      remaining: 0,
      severity: integrationIdempotencyTooWeakBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_too_weak_blocked"
      }
    });
  }

  const outboundDuplicateBlockedWithoutIdempotency = readCounter(outboundCounters, "outbound.duplicate_blocked_without_idempotency_key");
  if (outboundDuplicateBlockedWithoutIdempotency >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_duplicate_blocked_without_idempotency_spike",
      threshold: 3,
      inWindow: outboundDuplicateBlockedWithoutIdempotency,
      remaining: 0,
      severity: outboundDuplicateBlockedWithoutIdempotency >= 10 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundDuplicateBlocked = readCounter(outboundCounters, "outbound.duplicate_blocked");
  const outboundDedupeReserved = readCounter(outboundCounters, "outbound.dedupe_reserved");
  const outboundDedupeObserved = outboundDuplicateBlocked + outboundDedupeReserved;
  const outboundDuplicateBlockedPct = outboundDedupeObserved > 0
    ? Math.round((outboundDuplicateBlocked / outboundDedupeObserved) * 100)
    : null;

  if (typeof outboundDuplicateBlockedPct === "number"
    && outboundDedupeObserved >= 20
    && outboundDuplicateBlockedPct >= 20) {
    runtimeOutboundAlerts.push({
      signal: "outbound_duplicate_blocked_ratio_high",
      threshold: 20,
      inWindow: outboundDuplicateBlockedPct,
      remaining: 0,
      severity: outboundDuplicateBlockedPct >= 40 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        observed: outboundDedupeObserved,
        blocked: outboundDuplicateBlocked,
        allowed: outboundDedupeReserved
      }
    });
  }

  const outboundDedupeInfraErrors = readCounter(outboundCounters, "outbound.dedupe_infra_error");
  if (outboundDedupeInfraErrors >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_dedupe_infra_error_spike",
      threshold: 2,
      inWindow: outboundDedupeInfraErrors,
      remaining: 0,
      severity: outboundDedupeInfraErrors >= 5 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundDedupeFailClosedBlocked = readCounter(outboundCounters, "outbound.dedupe_fail_closed_blocked");
  if (outboundDedupeFailClosedBlocked >= 1) {
    runtimeOutboundAlerts.push({
      signal: "outbound_dedupe_fail_closed_blocked",
      threshold: 1,
      inWindow: outboundDedupeFailClosedBlocked,
      remaining: 0,
      severity: outboundDedupeFailClosedBlocked >= 3 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundManagedReplyDedupeMemoryReserved = readCounter(inboundCounters, "outbound.dedupe_memory_reserved");
  if (outboundManagedReplyDedupeMemoryReserved >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_managed_reply_dedupe_memory_reserved_spike",
      threshold: 3,
      inWindow: outboundManagedReplyDedupeMemoryReserved,
      remaining: 0,
      severity: outboundManagedReplyDedupeMemoryReserved >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.dedupe_memory_reserved"
      }
    });
  }

  const outboundManagedReplyDedupeMemoryBlocked = readCounter(inboundCounters, "outbound.dedupe_memory_blocked");
  if (outboundManagedReplyDedupeMemoryBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_managed_reply_dedupe_memory_blocked_spike",
      threshold: 2,
      inWindow: outboundManagedReplyDedupeMemoryBlocked,
      remaining: 0,
      severity: outboundManagedReplyDedupeMemoryBlocked >= 6 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.dedupe_memory_blocked"
      }
    });
  }

  const outboundDedupeEmergencyDuplicateBlocked = readCounter(outboundCounters, "outbound.dedupe_emergency_duplicate_blocked");
  if (outboundDedupeEmergencyDuplicateBlocked >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_dedupe_emergency_duplicate_blocked_spike",
      threshold: 2,
      inWindow: outboundDedupeEmergencyDuplicateBlocked,
      remaining: 0,
      severity: outboundDedupeEmergencyDuplicateBlocked >= 5 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundDedupeEmergencyTrimmed = readCounter(outboundCounters, "outbound.dedupe_emergency_trimmed");
  if (outboundDedupeEmergencyTrimmed >= 20) {
    runtimeOutboundAlerts.push({
      signal: "outbound_dedupe_emergency_trimmed_spike",
      threshold: 20,
      inWindow: outboundDedupeEmergencyTrimmed,
      remaining: 0,
      severity: outboundDedupeEmergencyTrimmed >= 100 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundDedupeReleaseFailed = readCounter(outboundCounters, "outbound.dedupe_release_failed_after_non_retryable_provider_error");
  if (outboundDedupeReleaseFailed >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_dedupe_release_failed_spike",
      threshold: 2,
      inWindow: outboundDedupeReleaseFailed,
      remaining: 0,
      severity: outboundDedupeReleaseFailed >= 5 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundDedupeReleaseNotFoundMemoryMode = readCounter(outboundCounters, "outbound.dedupe_release_not_found_after_non_retryable_provider_error_memory_mode")
    + readCounter(outboundCounters, "outbound.dedupe_release_not_found_after_non_retryable_provider_error_emergency_mode");
  if (outboundDedupeReleaseNotFoundMemoryMode >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_dedupe_release_not_found_memory_mode_spike",
      threshold: 2,
      inWindow: outboundDedupeReleaseNotFoundMemoryMode,
      remaining: 0,
      severity: outboundDedupeReleaseNotFoundMemoryMode >= 5 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.dedupe_release_not_found_after_non_retryable_provider_error_memory_mode"
      }
    });
  }

  return { runtimeInboundAlerts, runtimeOutboundAlerts };
};

whatsappCloudRoutes.get("/webhook", (req: any, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expected = String(getRuntimeSettings().waCloudVerifyToken || "").trim();

  if (mode === "subscribe" && timingSafeTokenEquals(expected, token)) {
    return res.status(200).send(String(challenge || ""));
  }

  return res.status(403).json({ error: "Verification failed" });
});

whatsappCloudRoutes.get("/webhook/hardening", (req: any, res) => {
  if (!hasValidHardeningToken(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const inbound = getWaHardeningMetrics();
  const outbound = getSendHardeningMetrics();
  const integrationApi = getIntegrationHardeningMetrics();
  const integrationApiAlerts = getIntegrationHardeningAlertSnapshot();
  const inboundAlerts = getWaHardeningAlertSnapshot();
  const outboundAlerts = getSendHardeningAlertSnapshot();

  const signatureHardening = resolveWebhookSignatureHardeningState();
  const outboundRetryHardening = resolveOutboundRetryHardeningState();
  const replayFailClosed = resolveWebhookPayloadReplayFailClosed();
  const derivedAlerts = buildDerivedHardeningAlerts(inbound, outbound, integrationApi, inboundAlerts);
  const runtimeInboundAlerts = [
    ...(signatureHardening.insecureUnsignedWebhookAllowed
      ? [{
        signal: "inbound_unsigned_webhook_allowed",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: "warn",
        source: "runtime_settings"
      }]
      : []),
    ...(!replayFailClosed
      ? [{
        signal: "inbound_payload_replay_fail_open",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: "warn",
        source: "runtime_settings"
      }]
      : []),
    ...derivedAlerts.runtimeInboundAlerts
  ];

  const runtimeOutboundAlerts = [
    ...(outboundRetryHardening.insecureRetryWithoutIdempotencyAllowed
      ? [{
        signal: "outbound_retry_without_idempotency_allowed",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: "warn",
        source: "runtime_settings"
      }]
      : []),
    ...(outboundRetryHardening.insecureManagedRetryWithoutIdempotencyAllowed
      ? [{
        signal: "outbound_managed_retry_without_idempotency_allowed",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: "warn",
        source: "runtime_settings"
      }]
      : []),
    ...(outboundRetryHardening.insecureOutboundWithoutIdempotencyAllowed
      ? [{
        signal: "outbound_without_idempotency_allowed",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: "warn",
        source: "runtime_settings"
      }]
      : []),
    ...(outboundRetryHardening.insecureDedupeFailOpen
      ? [{
        signal: "outbound_dedupe_fail_open",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: "warn",
        source: "runtime_settings"
      }]
      : []),
    ...(outboundRetryHardening.timeoutRetryEnabled
      ? [{
        signal: "outbound_timeout_retry_enabled",
        threshold: 1,
        inWindow: 1,
        remaining: 0,
        severity: outboundRetryHardening.timeoutRetryRequiresIdempotencyKey ? "info" : "warn",
        source: "runtime_settings",
        context: {
          timeoutRetryRequiresIdempotencyKey: outboundRetryHardening.timeoutRetryRequiresIdempotencyKey,
          timeoutRetryAllowsWithoutIdempotency: outboundRetryHardening.timeoutRetryAllowsWithoutIdempotency
        }
      }]
      : []),
    ...derivedAlerts.runtimeOutboundAlerts
  ];

  const inboundAlertsWithRuntime = {
    ...inboundAlerts,
    pendingAlerts: [
      ...(Array.isArray(inboundAlerts?.pendingAlerts) ? inboundAlerts.pendingAlerts : []),
      ...runtimeInboundAlerts
    ]
  };

  const outboundAlertsWithRuntime = {
    ...outboundAlerts,
    pendingAlerts: [
      ...(Array.isArray(outboundAlerts?.pendingAlerts) ? outboundAlerts.pendingAlerts : []),
      ...runtimeOutboundAlerts
    ]
  };

  const health = buildHardeningHealth(inboundAlertsWithRuntime, outboundAlertsWithRuntime, integrationApiAlerts);
  const summary = buildHardeningSummary(inbound, outbound, integrationApi, health, inboundAlerts);
  const failOnAlert = ["1", "true", "yes", "on"].includes(String(req.query?.failOnAlert || "").toLowerCase());

  return res.status(health.status !== "ok" && failOnAlert ? 503 : 200).json({
    ok: health.status === "ok",
    generatedAt: new Date().toISOString(),
    health,
    summary,
    inbound,
    outbound,
    integrationApiHardening: integrationApi,
    alerts: {
      inbound: inboundAlertsWithRuntime,
      outbound: outboundAlertsWithRuntime,
      integrationApi: integrationApiAlerts
    },
    signatureHardening,
    webhookPayloadReplayHardening: {
      failClosed: replayFailClosed,
      insecureReplayGuardFailOpen: !replayFailClosed,
      replayWindowMs: resolveWebhookReplayWindowMs(),
      futureSkewMs: resolveWebhookFutureTimestampSkewMs(),
      eventNonceCacheMaxEntries: resolveWebhookEventNonceCacheMaxEntries(),
      eventNonceCacheEntries: webhookEventNonceCache.size
    },
    outboundRetryHardening
  });
});

whatsappCloudRoutes.post("/webhook", async (req, res) => {
  if (!isWebhookJsonContentTypeValid(req)) {
    recordInboundInvalidContentTypeBlocked({
      contentType: String(req.get("content-type") || "").trim() || null
    });
    return res.status(415).json({ error: "Unsupported webhook Content-Type", expected: "application/json" });
  }

  const rawBody = resolveRawBodyForSignature(req);
  const rawBodyBytes = Buffer.byteLength(rawBody, "utf8");
  const maxBodyBytes = resolveWebhookMaxBodyBytes();
  if (rawBodyBytes > maxBodyBytes) {
    recordInboundPayloadOversizeBlocked({ rawBodyBytes, maxBodyBytes });
    return res.status(413).json({ error: "Webhook payload too large" });
  }

  const envelopeValidation = validateEnvelope(req);
  if (!envelopeValidation.ok) {
    recordInboundInvalidEnvelopeBlocked({
      reason: envelopeValidation.reason,
      entryCount: envelopeValidation.entryCount ?? null
    });
    return res.status(400).json({ error: "Invalid webhook envelope", reason: envelopeValidation.reason });
  }

  const timestampValidation = validateWebhookTimestampWindow(req);
  if (!timestampValidation.ok) {
    recordInboundTimestampOutsideAllowedSkewBlocked({
      reason: timestampValidation.reason,
      ageMs: timestampValidation.ageMs ?? null,
      replayWindowMs: timestampValidation.replayWindowMs,
      futureSkewMs: timestampValidation.futureSkewMs
    });
    return res.status(400).json({
      error: "Invalid webhook timestamp",
      reason: timestampValidation.reason,
      replayWindowMs: timestampValidation.replayWindowMs,
      futureSkewMs: timestampValidation.futureSkewMs
    });
  }

  const nonceReservation = reserveWebhookEventNonce(req);
  if (!nonceReservation.accepted) {
    recordInboundEventNonceReplayBlocked({
      reason: nonceReservation.reason,
      nonce: nonceReservation.nonce || null,
      replayKeyStrategy: "event_nonce"
    });
    recordInboundPayloadReplayBlocked({
      reason: nonceReservation.reason,
      nonce: nonceReservation.nonce || null,
      replayKeyStrategy: "event_nonce"
    });
    return res.status(202).json({ ok: true, ignored: true, reason: "event_nonce_replay_blocked" });
  }

  const forwardedForHeaderRaw = String(req.get("x-forwarded-for") || "");
  const forwardedForHeaderMaxLength = resolveWebhookForwardedForHeaderMaxLength();
  if (forwardedForHeaderRaw.length > forwardedForHeaderMaxLength) {
    recordInboundForwardedHeaderOversizeBlocked({
      observedLength: forwardedForHeaderRaw.length,
      maxLength: forwardedForHeaderMaxLength
    });
    return res.status(400).json({ error: "Forwarded header too long" });
  }

  const signatureHeaderRaw = String(req.get("x-hub-signature-256") || "");
  const signatureHeaderMaxLength = resolveWebhookSignatureHeaderMaxLength();
  if (signatureHeaderRaw.length > signatureHeaderMaxLength) {
    const signatureRateLimit = shouldRateLimitInvalidSignatureByIp(req);
    recordInboundSignatureMalformedBlocked({
      hasSignatureHeader: true,
      appSecretConfigured: Boolean(String(getRuntimeSettings().waCloudAppSecret || "").trim()),
      ip: signatureRateLimit.ip,
      ipHits: signatureRateLimit.hits,
      ipMaxHits: signatureRateLimit.maxHits,
      ipWindowMs: signatureRateLimit.windowMs,
      reason: "signature_header_too_long",
      observedLength: signatureHeaderRaw.length,
      maxLength: signatureHeaderMaxLength
    });
    recordInboundSignatureInvalidBlocked({
      hasSignatureHeader: true,
      appSecretConfigured: Boolean(String(getRuntimeSettings().waCloudAppSecret || "").trim()),
      ip: signatureRateLimit.ip,
      ipHits: signatureRateLimit.hits,
      ipMaxHits: signatureRateLimit.maxHits,
      ipWindowMs: signatureRateLimit.windowMs,
      reason: "signature_header_too_long"
    });
    if (signatureRateLimit.limited) {
      recordInboundSignatureInvalidRateLimited({
        ip: signatureRateLimit.ip,
        hits: signatureRateLimit.hits,
        maxHits: signatureRateLimit.maxHits,
        windowMs: signatureRateLimit.windowMs,
        reason: "signature_header_too_long"
      });
      return res.status(429).json({ error: "Too many invalid webhook signatures" });
    }
    return res.status(400).json({ error: "Webhook signature header too long" });
  }

  const signatureHeader = classifySignatureHeader(signatureHeaderRaw);
  const appSecretConfigured = Boolean(String(getRuntimeSettings().waCloudAppSecret || "").trim());

  if (appSecretConfigured && !signatureHeader.valid) {
    const signatureRateLimit = shouldRateLimitInvalidSignatureByIp(req);

    if (signatureHeader.reason === "missing") {
      recordInboundSignatureMissingBlocked({
        hasSignatureHeader: false,
        appSecretConfigured,
        ip: signatureRateLimit.ip,
        ipHits: signatureRateLimit.hits,
        ipMaxHits: signatureRateLimit.maxHits,
        ipWindowMs: signatureRateLimit.windowMs,
        reason: "signature_header_missing"
      });
    } else if (signatureHeader.reason === "malformed") {
      recordInboundSignatureMalformedBlocked({
        hasSignatureHeader: true,
        appSecretConfigured,
        ip: signatureRateLimit.ip,
        ipHits: signatureRateLimit.hits,
        ipMaxHits: signatureRateLimit.maxHits,
        ipWindowMs: signatureRateLimit.windowMs,
        reason: "signature_header_malformed"
      });
    }

    recordInboundSignatureInvalidBlocked({
      hasSignatureHeader: signatureHeader.reason !== "missing",
      appSecretConfigured,
      ip: signatureRateLimit.ip,
      ipHits: signatureRateLimit.hits,
      ipMaxHits: signatureRateLimit.maxHits,
      ipWindowMs: signatureRateLimit.windowMs,
      reason: signatureHeader.reason === "missing" ? "signature_header_missing" : "signature_header_malformed"
    });

    if (signatureRateLimit.limited) {
      recordInboundSignatureInvalidRateLimited({
        ip: signatureRateLimit.ip,
        hits: signatureRateLimit.hits,
        maxHits: signatureRateLimit.maxHits,
        windowMs: signatureRateLimit.windowMs,
        reason: signatureHeader.reason === "missing" ? "signature_header_missing" : "signature_header_malformed"
      });
      return res.status(429).json({ error: "Too many invalid webhook signatures" });
    }

    return res.status(401).json({
      error: signatureHeader.reason === "missing" ? "Missing webhook signature" : "Malformed webhook signature"
    });
  }

  if (!isWebhookSignatureValid(req, signatureHeader)) {
    const signatureRateLimit = shouldRateLimitInvalidSignatureByIp(req);

    recordInboundSignatureInvalidBlocked({
      hasSignatureHeader: Boolean(signatureHeaderRaw.trim()),
      appSecretConfigured,
      ip: signatureRateLimit.ip,
      ipHits: signatureRateLimit.hits,
      ipMaxHits: signatureRateLimit.maxHits,
      ipWindowMs: signatureRateLimit.windowMs,
      reason: "signature_digest_mismatch"
    });

    if (signatureRateLimit.limited) {
      recordInboundSignatureInvalidRateLimited({
        ip: signatureRateLimit.ip,
        hits: signatureRateLimit.hits,
        maxHits: signatureRateLimit.maxHits,
        windowMs: signatureRateLimit.windowMs,
        reason: "signature_digest_mismatch"
      });
      return res.status(429).json({ error: "Too many invalid webhook signatures" });
    }

    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  try {
    if (!(await reserveWebhookPayloadReplay(req))) {
      const replayReuseByIp = trackPayloadReplayKeyReuseByIp(req);
      const replayContext = {
        hasSignatureHeader: Boolean(String(req.get("x-hub-signature-256") || "").trim()),
        replayKeyStrategy: "object_entrycount_sha256_body",
        ip: replayReuseByIp.ip,
        replayKeyHash: replayReuseByIp.replayKeyHash,
        replayKeyHitsByIpInWindow: replayReuseByIp.hits,
        replayKeyReuseThreshold: replayReuseByIp.threshold,
        replayKeyReuseWindowMs: replayReuseByIp.windowMs
      };
      recordInboundPayloadReplayBlocked(replayContext);
      recordInboundPayloadReplayKeyCollisionOrRepeat(replayContext);
      if (replayReuseByIp.detected) {
        recordInboundPayloadReplayKeyReuseByIpDetected(replayContext);
      }
      return res.status(202).json({ ok: true, ignored: true, reason: "payload_replay_blocked" });
    }
  } catch (replayGuardError: any) {
    recordInboundPayloadReplayGuardFailClosedBlocked({
      reason: "payload_replay_guard_unavailable_fail_closed",
      error: replayGuardError?.message || String(replayGuardError)
    });
    return res.status(503).json({ error: "Webhook replay guard unavailable (fail-closed)" });
  }

  const result = await processCloudWebhookPayload(req.body || {});
  return res.status(200).json({ ok: true, ...result });
});

export default whatsappCloudRoutes;
