import crypto from "crypto";
import { Router } from "express";
import { QueryTypes } from "sequelize";
import sequelize from "../../database";
import { processCloudWebhookPayload, recordInboundSignatureInvalidBlocked, recordInboundSignatureMissingBlocked, recordInboundSignatureMalformedBlocked, recordInboundSignatureInvalidRateLimited, recordInboundPayloadReplayBlocked, recordInboundPayloadReplayGuardInfraError, recordInboundPayloadReplayGuardFailClosedBlocked, recordInboundPayloadOversizeBlocked, recordInboundInvalidEnvelopeBlocked, recordInboundInvalidContentTypeBlocked, getWaHardeningMetrics, getWaHardeningAlertSnapshot } from "./ProcessCloudWebhookService";
import { getSendHardeningMetrics, getSendHardeningAlertSnapshot } from "./SendMessageService_patched";
import { getIntegrationHardeningMetrics, getIntegrationHardeningAlertSnapshot } from "./integrationRoutes";
import { getRuntimeSettings } from "./RuntimeSettingsService";

const whatsappCloudRoutes = Router();

const webhookPayloadReplayCache = new Map<string, number>();
const webhookInvalidSignatureIpBuckets = new Map<string, number[]>();

let webhookPayloadReplayTableReady = false;
let webhookPayloadReplayLastPruneAt = 0;
const WEBHOOK_PAYLOAD_REPLAY_PRUNE_INTERVAL_MS = 60 * 1000;

const resolveRawBodyForSignature = (req: any): string => {
  if (typeof req?.rawBody === "string") return req.rawBody;
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody.toString("utf8");
  return JSON.stringify(req?.body || {});
};

const buildWebhookPayloadReplayKey = (req: any): string => {
  const signatureHeader = String(req.get("x-hub-signature-256") || "").trim();
  const bodyRaw = resolveRawBodyForSignature(req);
  const digest = crypto.createHash("sha256").update(bodyRaw, "utf8").digest("hex");
  return `${signatureHeader || "no-sig"}:${digest}`;
};

const resolveWebhookPayloadReplayTtlMs = (): number => {
  const n = Number(getRuntimeSettings().waWebhookPayloadReplayTtlSeconds || 120);
  if (!Number.isFinite(n)) return 120000;
  return Math.max(10000, Math.min(900000, Math.round(n * 1000)));
};

const resolveWebhookPayloadReplayCacheMaxEntries = (): number => {
  const n = Number(getRuntimeSettings().waWebhookPayloadReplayCacheMaxEntries || 5000);
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

const isWebhookJsonContentTypeValid = (req: any): boolean => {
  const raw = String(req.get("content-type") || "").trim().toLowerCase();
  if (!raw) return false;
  return raw === "application/json" || raw.startsWith("application/json;");
};

const ensureWebhookPayloadReplayTable = async () => {
  if (webhookPayloadReplayTableReady) return;
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ai_webhook_payload_replay_guard (id SERIAL PRIMARY KEY, replay_key VARCHAR(220) UNIQUE NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_webhook_payload_replay_guard_key ON ai_webhook_payload_replay_guard(replay_key)`);
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

const resolveRequesterIp = (req: any): string => {
  const forwarded = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
  const direct = String(req.ip || req.socket?.remoteAddress || "").trim();
  const candidate = forwarded || direct || "unknown";
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

const trimWebhookPayloadReplayCache = (maxEntries: number) => {
  if (webhookPayloadReplayCache.size <= maxEntries) return;
  const overflow = webhookPayloadReplayCache.size - maxEntries;
  let removed = 0;
  for (const key of webhookPayloadReplayCache.keys()) {
    webhookPayloadReplayCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
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

const resolveAllowUnsignedWebhook = (): boolean => {
  const raw = String((getRuntimeSettings() as any).waWebhookAllowUnsigned || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
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

  const dedupeFailClosed = Boolean(settings.waOutboundDedupeFailClosed);
  const timeoutRetryEnabled = Boolean(settings.waOutboundRetryOnTimeout);

  return {
    retryRequiresIdempotencyKey,
    insecureRetryWithoutIdempotencyAllowed: !retryRequiresIdempotencyKey,
    managedRetryRequiresIdempotencyKey,
    insecureManagedRetryWithoutIdempotencyAllowed: !managedRetryRequiresIdempotencyKey,
    outboundRequiresIdempotencyKey,
    insecureOutboundWithoutIdempotencyAllowed: !outboundRequiresIdempotencyKey,
    dedupeFailClosed,
    insecureDedupeFailOpen: !dedupeFailClosed,
    timeoutRetryEnabled,
    timeoutRetryRequiresIdempotencyKey: timeoutRetryEnabled && retryRequiresIdempotencyKey
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

const hasValidHardeningToken = (req: any): boolean => {
  const expected = String(getRuntimeSettings().waCloudVerifyToken || "").trim();
  if (!expected) return false;

  const candidate = String(
    req.get("x-hardening-token")
      || req.query?.token
      || req.query?.verify_token
      || ""
  ).trim();

  return candidate.length > 0 && candidate === expected;
};

const CRITICAL_HARDENING_SIGNALS = new Set([
  "outbound_retry_exhausted",
  "outbound_wbot_retry_exhausted",
  "outbound_dedupe_fail_closed_blocked",
  "outbound_integration_retry_blocked_missing_idempotency_key",
  "outbound_integration_retry_idempotency_key_required_blocked", // backward-compatible signal name from integrationRoutes
  "outbound_integration_idempotency_key_missing_blocked",
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

const buildHardeningHealth = (inboundAlerts: any, outboundAlerts: any) => {
  const pendingAlerts = [
    ...(Array.isArray(inboundAlerts?.pendingAlerts) ? inboundAlerts.pendingAlerts : []),
    ...(Array.isArray(outboundAlerts?.pendingAlerts) ? outboundAlerts.pendingAlerts : [])
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

const buildHardeningSummary = (inbound: any, outbound: any, integrationApi: any, health: any) => {
  const inboundCounters = inbound?.counters || {};
  const outboundCounters = outbound?.counters || {};
  const integrationApiCounters = integrationApi?.counters || {};

  const idempotencyKeyUsed = readCounter(outboundCounters, "outbound.idempotency_key_used");
  const missingIdempotencyKey = readCounter(outboundCounters, "outbound.idempotency_key_missing");
  const idempotencyObservedTotal = idempotencyKeyUsed + missingIdempotencyKey;
  const idempotencyCoveragePct = idempotencyObservedTotal > 0
    ? Math.round((idempotencyKeyUsed / idempotencyObservedTotal) * 100)
    : null;

  const summary = {
    status: String(health?.status || "ok"),
    outbound: {
      duplicateBlocked: readCounter(outboundCounters, "outbound.duplicate_blocked"),
      idempotencyKeyUsed,
      missingIdempotencyKey,
      idempotencyObservedTotal,
      idempotencyCoveragePct,
      missingIdempotencyKeyBlocked: readCounter(outboundCounters, "outbound.missing_idempotency_key_blocked"),
      idempotencyKeyTooWeakBlocked: readCounter(outboundCounters, "outbound.idempotency_key_too_weak_blocked"),
      idempotencyKeyTimestampOnlyBlocked: readCounter(outboundCounters, "outbound.idempotency_key_timestamp_only_blocked"),
      retryBlockedNoIdempotencyKey: readCounter(outboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
        + readCounter(outboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key"),
      retryBlockedUnknownTransportNoIdempotencyKey: readCounter(outboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key"),
      retryExhaustedAlerts: readCounter(outboundCounters, "alert.outbound_retry_exhausted")
        + readCounter(outboundCounters, "alert.outbound_wbot_retry_exhausted"),
      dedupeInfraErrors: readCounter(outboundCounters, "outbound.dedupe_infra_error"),
      dedupeFailClosedBlocked: readCounter(outboundCounters, "outbound.dedupe_fail_closed_blocked"),
      dedupeEmergencyReserved: readCounter(outboundCounters, "outbound.dedupe_emergency_reserved"),
      dedupeEmergencyDuplicateBlocked: readCounter(outboundCounters, "outbound.dedupe_emergency_duplicate_blocked"),
      dedupeEmergencyTrimmed: readCounter(outboundCounters, "outbound.dedupe_emergency_trimmed"),
      dedupeReleaseFailedAfterNonRetryableProviderError: readCounter(outboundCounters, "outbound.dedupe_release_failed_after_non_retryable_provider_error"),
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
      payloadReplayBlocked: readCounter(inboundCounters, "inbound.payload_replay_blocked"),
      payloadReplayGuardInfraErrors: readCounter(inboundCounters, "inbound.payload_replay_guard_infra_error"),
      payloadReplayGuardFailClosedBlocked: readCounter(inboundCounters, "inbound.payload_replay_guard_fail_closed_blocked"),
      payloadSizeBlocked: readCounter(inboundCounters, "inbound.payload_size_blocked"),
      payloadVolumeBlocked: readCounter(inboundCounters, "inbound.payload_volume_blocked"),
      replayMessageBlocked: readCounter(inboundCounters, "inbound.replay_blocked")
    },
    integrationApi: {
      sendAttemptAccepted: readCounter(integrationApiCounters, "outbound.send_attempt_accepted"),
      sendAttemptFailed: readCounter(integrationApiCounters, "outbound.send_attempt_failed"),
      idempotencyKeyInvalidFormatBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_format_blocked"),
      idempotencyKeyInvalidCharsBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_invalid_chars_blocked"),
      idempotencyKeyMissingBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_required_blocked"),
      retryBlockedMissingIdempotencyKey: readCounter(integrationApiCounters, "outbound.retry_idempotency_key_required_blocked"),
      idempotencyKeyTooWeakBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_too_weak_blocked"),
      idempotencyKeyTimestampOnlyBlocked: readCounter(integrationApiCounters, "outbound.idempotency_key_timestamp_only_blocked")
    }
  };

  const recommendations: string[] = [];
  if (summary.outbound.retryBlockedNoIdempotencyKey > 0) {
    recommendations.push("Agregar Idempotency-Key en clientes outbound para habilitar reintentos seguros.");
  }
  if (summary.outbound.retryBlockedUnknownTransportNoIdempotencyKey > 0) {
    recommendations.push("Se bloquearon reintentos por errores de transporte ambiguos sin Idempotency-Key: instrumentar claves idempotentes en clientes para cubrir cortes de red/timeouts intermedios.");
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
  if (summary.outbound.idempotencyKeyTooWeakBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key débil: usar claves con entropía real (UUID/ULID) y al menos 2 caracteres distintos.");
  }
  if (summary.outbound.idempotencyKeyTimestampOnlyBlocked > 0) {
    recommendations.push("Se bloquearon envíos por Idempotency-Key timestamp-only: evitar timestamps crudos y usar UUID/ULID para reducir colisiones y reintentos duplicados.");
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
  if (summary.integrationApi.sendAttemptFailed > 0) {
    recommendations.push("Hubo fallos reales en envíos outbound de Integration API: revisar logs de provider/credenciales y aplicar retry del lado cliente con Idempotency-Key fuerte para evitar duplicados.");
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
  if (summary.inbound.signatureInvalidRateLimited > 0) {
    recommendations.push("Se activó rate-limit por firmas inválidas: bloquear IPs ofensivas en edge (WAF/proxy) y revisar intentos de spoofing.");
  }
  if (summary.inbound.invalidEnvelopeBlocked > 0) {
    recommendations.push("Verificar productores del webhook: se detectaron envelopes inválidos bloqueados por hardening.");
  }
  if (summary.inbound.invalidContentTypeBlocked > 0) {
    recommendations.push("Se bloquearon webhooks con Content-Type no JSON: corregir cliente/proxy para enviar application/json y evitar rechazos 415.");
  }
  if (summary.inbound.payloadReplayBlocked > 0 || summary.inbound.replayMessageBlocked > 0) {
    recommendations.push("Investigar origen de replay (reintentos de proveedor o duplicados de integración).");
  }
  if (summary.inbound.payloadReplayGuardInfraErrors > 0) {
    recommendations.push("Se activó fallback en memoria del guard de replay de payload: revisar disponibilidad DB/migraciones para recuperar persistencia.");
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
  if (summary.outbound.dedupeReleaseFailedAfterNonRetryableProviderError > 0) {
    recommendations.push("Falló la liberación de dedupe tras errores no reintentables del proveedor: revisar permisos/disponibilidad DB para evitar bloqueos falsos en próximos envíos.");
  }
  if (summary.outbound.dedupeFailClosedBlocked > 0) {
    recommendations.push("Hay envíos bloqueados por fail-closed de dedupe: revisar conectividad DB antes de reintentar outbound.");
  }

  return {
    ...summary,
    recommendations
  };
};

const buildDerivedHardeningAlerts = (inbound: any, outbound: any, integrationApi?: any) => {
  const inboundCounters = inbound?.counters || {};
  const outboundCounters = outbound?.counters || {};
  const integrationApiCounters = integrationApi?.counters || {};

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
      }
    });
  }

  const outboundRetryBlockedMissingIdempotency = readCounter(outboundCounters, "outbound.cloud_retry_blocked_missing_idempotency_key")
    + readCounter(outboundCounters, "outbound.wbot_retry_blocked_missing_idempotency_key");
  if (outboundRetryBlockedMissingIdempotency >= 3) {
    runtimeOutboundAlerts.push({
      signal: "outbound_retry_blocked_missing_idempotency_spike",
      threshold: 3,
      inWindow: outboundRetryBlockedMissingIdempotency,
      remaining: 0,
      severity: outboundRetryBlockedMissingIdempotency >= 10 ? "critical" : "warn",
      source: "derived_metrics"
    });
  }

  const outboundRetryBlockedUnknownTransportNoIdempotency = readCounter(outboundCounters, "outbound.cloud_retry_blocked_unknown_transport_without_idempotency_key");
  if (outboundRetryBlockedUnknownTransportNoIdempotency >= 2) {
    runtimeOutboundAlerts.push({
      signal: "outbound_retry_blocked_unknown_transport_without_idempotency_spike",
      threshold: 2,
      inWindow: outboundRetryBlockedUnknownTransportNoIdempotency,
      remaining: 0,
      severity: outboundRetryBlockedUnknownTransportNoIdempotency >= 6 ? "critical" : "warn",
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

  const integrationWeakIdempotencyBlocked = readCounter(integrationApiCounters, "outbound.idempotency_key_too_weak_blocked");
  if (integrationWeakIdempotencyBlocked >= 3) {
    runtimeOutboundAlerts.push({
      signal: "integration_api_idempotency_key_too_weak_spike",
      threshold: 3,
      inWindow: integrationWeakIdempotencyBlocked,
      remaining: 0,
      severity: integrationWeakIdempotencyBlocked >= 10 ? "critical" : "warn",
      source: "derived_metrics",
      details: {
        metric: "outbound.idempotency_key_too_weak_blocked"
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

  return { runtimeInboundAlerts, runtimeOutboundAlerts };
};

whatsappCloudRoutes.get("/webhook", (req: any, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expected = getRuntimeSettings().waCloudVerifyToken || "";

  if (mode === "subscribe" && expected && token === expected) {
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
  const derivedAlerts = buildDerivedHardeningAlerts(inbound, outbound, integrationApi);
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
          timeoutRetryRequiresIdempotencyKey: outboundRetryHardening.timeoutRetryRequiresIdempotencyKey
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

  const health = buildHardeningHealth(inboundAlertsWithRuntime, outboundAlertsWithRuntime);
  const summary = buildHardeningSummary(inbound, outbound, integrationApi, health);
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
      insecureReplayGuardFailOpen: !replayFailClosed
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

  const signatureHeaderRaw = String(req.get("x-hub-signature-256") || "");
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
      recordInboundPayloadReplayBlocked({
        hasSignatureHeader: Boolean(String(req.get("x-hub-signature-256") || "").trim())
      });
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
