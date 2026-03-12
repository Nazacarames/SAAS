import crypto from "crypto";
import { Router } from "express";
import { QueryTypes } from "sequelize";
import sequelize from "../../database";
import integrationAuth from "../../middleware/integrationAuth";
import CreateLeadService from "../../services/IntegrationServices/CreateLeadService";
import SendOutboundTextService from "../../services/IntegrationServices/SendOutboundTextService";
import featureGate from "../../middleware/featureGate";
import { incrementUsage } from "../../services/BillingServices/BillingService";
import { getRuntimeSettings } from "../../services/SettingsServices/RuntimeSettingsService";

const integrationRoutes = Router();

const resolveOutboundRetryRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any)?.waOutboundRetryRequireIdempotencyKey;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const resolveOutboundRequireIdempotencyKey = (): boolean => {
  const raw = (getRuntimeSettings() as any)?.waOutboundRequireIdempotencyKey;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const resolveOutboundIdempotencyKeyMinLength = (): number => {
  const raw = Number((getRuntimeSettings() as any)?.waOutboundIdempotencyKeyMinLength);
  if (!Number.isFinite(raw)) return 8;
  return Math.max(4, Math.min(64, Math.round(raw)));
};

const IDEMPOTENCY_KEY_MAX_LENGTH = 120;

const integrationHardeningCounters = new Map<string, number>();
const integrationHardeningLastAt = new Map<string, string>();
const integrationHardeningSignalBuckets = new Map<string, number[]>();
const integrationHardeningSignalThresholds = new Map<string, number>();

const INTEGRATION_HARDENING_ALERT_WINDOW_MS = 10 * 60 * 1000;
const OUTBOUND_REPLAY_GUARD_TTL_MS = 2 * 60 * 60 * 1000;
const OUTBOUND_REPLAY_GUARD_MEMORY_MAX_ENTRIES_DEFAULT = 50000;

type OutboundReplayGuardEntry = {
  createdAt: number;
  fingerprint: string;
  state: "inflight" | "done";
  response?: any;
};

const OUTBOUND_REPLAY_GUARD_INFLIGHT_STALE_MS = 90 * 1000;
const OUTBOUND_NO_KEY_FINGERPRINT_GUARD_TTL_MS = 90 * 1000;
const OUTBOUND_DUPLICATE_INFLIGHT_RETRY_AFTER_MS = 2000;
const RETRY_ATTEMPT_VALID_MAX = 1000;

type OutboundNoKeyFingerprintGuardEntry = {
  createdAt: number;
};

const outboundReplayGuard = new Map<string, OutboundReplayGuardEntry>();
const outboundNoKeyFingerprintGuard = new Map<string, OutboundNoKeyFingerprintGuardEntry>();

let outboundReplayGuardTableReady = false;
let outboundReplayGuardLastPruneAt = 0;
const OUTBOUND_REPLAY_GUARD_PRUNE_INTERVAL_MS = 60 * 1000;

const ensureOutboundReplayGuardTable = async (): Promise<void> => {
  if (outboundReplayGuardTableReady) return;

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS ai_integration_outbound_replay_guard (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      idempotency_key VARCHAR(140) NOT NULL,
      fingerprint VARCHAR(400) NOT NULL,
      state VARCHAR(16) NOT NULL,
      response_json TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(company_id, idempotency_key)
    )
  `);

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_integration_outbound_replay_guard_created_at
    ON ai_integration_outbound_replay_guard(created_at)
  `);

  outboundReplayGuardTableReady = true;
};

const pruneOutboundReplayGuardPersistentIfDue = async (): Promise<void> => {
  const now = Date.now();
  if (now - outboundReplayGuardLastPruneAt < OUTBOUND_REPLAY_GUARD_PRUNE_INTERVAL_MS) return;
  outboundReplayGuardLastPruneAt = now;

  await sequelize.query(
    `DELETE FROM ai_integration_outbound_replay_guard
      WHERE created_at < NOW() - (:ttlSeconds::text || ' seconds')::interval`,
    {
      replacements: { ttlSeconds: Math.max(60, Math.round(OUTBOUND_REPLAY_GUARD_TTL_MS / 1000)) },
      type: QueryTypes.DELETE
    }
  );
};

const pruneOutboundReplayGuard = (now = Date.now()): void => {
  for (const [key, entry] of outboundReplayGuard.entries()) {
    if (now - entry.createdAt > OUTBOUND_REPLAY_GUARD_TTL_MS) {
      outboundReplayGuard.delete(key);
    }
  }
};

const pruneOutboundNoKeyFingerprintGuard = (now = Date.now()): void => {
  for (const [key, entry] of outboundNoKeyFingerprintGuard.entries()) {
    if (now - entry.createdAt > OUTBOUND_NO_KEY_FINGERPRINT_GUARD_TTL_MS) {
      outboundNoKeyFingerprintGuard.delete(key);
    }
  }
};

const resolveOutboundReplayGuardMemoryMaxEntries = (): number => {
  const raw = Number((getRuntimeSettings() as any)?.waOutboundReplayGuardMemoryMaxEntries);
  if (!Number.isFinite(raw)) return OUTBOUND_REPLAY_GUARD_MEMORY_MAX_ENTRIES_DEFAULT;
  return Math.max(500, Math.min(500000, Math.round(raw)));
};

const resolveOutboundReplayGuardFailClosed = (): boolean => {
  const raw = (getRuntimeSettings() as any)?.waOutboundReplayGuardFailClosed;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const normalizeOutboundReplayText = (raw: unknown): string => String(raw || "")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .replace(/\s+/g, " ")
  .trim();

const normalizeOutboundReplayPhone = (raw: unknown): string => String(raw || "")
  // normalize to digits-only to keep replay fingerprint stable across formatting variants
  // e.g. "+54 9 11..." and "54911..." must map to the same outbound request identity.
  .replace(/\D/g, "")
  .slice(0, 20)
  .trim();

const buildOutboundReplayFingerprint = (payload: any): string => {
  const whatsappId = String(payload?.whatsappId || "").trim().toLowerCase();
  const to = normalizeOutboundReplayPhone(payload?.to);
  const text = normalizeOutboundReplayText(payload?.text)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase();
  const contactName = normalizeOutboundReplayText(payload?.contactName)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase();

  // keep replay fingerprint stable and bounded for persistent guard storage (VARCHAR(400))
  // while preserving low collision risk across long outbound texts.
  const canonical = JSON.stringify({ whatsappId, to, text, contactName });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
};

const tryReserveOutboundReplayGuardPersistentInflight = async (companyId: number, idempotencyKey: string, fingerprint: string): Promise<boolean> => {
  await ensureOutboundReplayGuardTable();
  await pruneOutboundReplayGuardPersistentIfDue();

  const rows: any[] = await sequelize.query(
    `INSERT INTO ai_integration_outbound_replay_guard (company_id, idempotency_key, fingerprint, state, response_json, created_at, updated_at)
     VALUES (:companyId, :idempotencyKey, :fingerprint, 'inflight', NULL, NOW(), NOW())
     ON CONFLICT (company_id, idempotency_key) DO NOTHING
     RETURNING id`,
    {
      replacements: { companyId, idempotencyKey, fingerprint },
      type: QueryTypes.SELECT
    }
  );

  return Boolean(rows[0]?.id);
};

const getOutboundReplayGuardPersistent = async (companyId: number, idempotencyKey: string): Promise<{ fingerprint: string; state: "inflight" | "done"; createdAtMs: number; response?: any } | null> => {
  await ensureOutboundReplayGuardTable();
  await pruneOutboundReplayGuardPersistentIfDue();

  const rows: any[] = await sequelize.query(
    `SELECT fingerprint, state, response_json, created_at
     FROM ai_integration_outbound_replay_guard
     WHERE company_id = :companyId AND idempotency_key = :idempotencyKey
     LIMIT 1`,
    {
      replacements: { companyId, idempotencyKey },
      type: QueryTypes.SELECT
    }
  );

  const row = rows[0];
  if (!row) return null;

  let response: any;
  if (row.response_json) {
    try {
      response = JSON.parse(String(row.response_json));
    } catch {
      response = undefined;
    }
  }

  return {
    fingerprint: String(row.fingerprint || ""),
    state: String(row.state || "inflight") === "done" ? "done" : "inflight",
    createdAtMs: row.created_at ? Date.parse(String(row.created_at)) || 0 : 0,
    response
  };
};

const markOutboundReplayGuardPersistentDone = async (companyId: number, idempotencyKey: string, fingerprint: string, response: any): Promise<void> => {
  await ensureOutboundReplayGuardTable();

  await sequelize.query(
    `UPDATE ai_integration_outbound_replay_guard
     SET state = 'done',
         fingerprint = :fingerprint,
         response_json = :responseJson,
         updated_at = NOW()
     WHERE company_id = :companyId AND idempotency_key = :idempotencyKey`,
    {
      replacements: {
        companyId,
        idempotencyKey,
        fingerprint,
        responseJson: JSON.stringify(response || {})
      },
      type: QueryTypes.UPDATE
    }
  );
};

const clearOutboundReplayGuardPersistent = async (companyId: number, idempotencyKey: string): Promise<void> => {
  await ensureOutboundReplayGuardTable();

  await sequelize.query(
    `DELETE FROM ai_integration_outbound_replay_guard
     WHERE company_id = :companyId AND idempotency_key = :idempotencyKey`,
    {
      replacements: { companyId, idempotencyKey },
      type: QueryTypes.DELETE
    }
  );
};

const bumpIntegrationHardeningMetric = (metric: string, by = 1): void => {
  const next = (integrationHardeningCounters.get(metric) || 0) + by;
  integrationHardeningCounters.set(metric, next);
  integrationHardeningLastAt.set(metric, new Date().toISOString());
};

const pushIntegrationHardeningSignal = (signal: string, threshold: number): void => {
  const now = Date.now();
  const safeThreshold = Math.max(1, Number(threshold) || 1);
  integrationHardeningSignalThresholds.set(signal, safeThreshold);

  const prev = integrationHardeningSignalBuckets.get(signal) || [];
  const next = prev.filter((ts) => now - ts < INTEGRATION_HARDENING_ALERT_WINDOW_MS);
  next.push(now);
  integrationHardeningSignalBuckets.set(signal, next);
};

const enforceOutboundReplayGuardMemoryCapacity = (): void => {
  const maxEntries = resolveOutboundReplayGuardMemoryMaxEntries();
  if (outboundReplayGuard.size <= maxEntries) return;

  const overflow = outboundReplayGuard.size - maxEntries;
  const keysByOldest = Array.from(outboundReplayGuard.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, overflow)
    .map(([key]) => key);

  for (const key of keysByOldest) {
    outboundReplayGuard.delete(key);
  }

  if (keysByOldest.length > 0) {
    bumpIntegrationHardeningMetric("outbound.replay_guard_memory_evicted", keysByOldest.length);
    pushIntegrationHardeningSignal("outbound_integration_replay_guard_memory_evicted", 1);
  }
};

export const getIntegrationHardeningMetrics = () => ({
  counters: Object.fromEntries(Array.from(integrationHardeningCounters.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
  lastSeenAt: Object.fromEntries(Array.from(integrationHardeningLastAt.entries()).sort((a, b) => a[0].localeCompare(b[0])))
});

export const getIntegrationHardeningAlertSnapshot = () => {
  const now = Date.now();

  const pendingAlerts = Array.from(integrationHardeningSignalBuckets.entries())
    .map(([signal, hits]) => {
      const threshold = integrationHardeningSignalThresholds.get(signal) || 1;
      const inWindow = hits.filter((ts) => now - ts < INTEGRATION_HARDENING_ALERT_WINDOW_MS).length;
      const severity = signal === "outbound_integration_retry_idempotency_key_required_blocked"
        ? (inWindow >= 3 ? "critical" : "warn")
        : (inWindow >= threshold * 3 ? "critical" : "warn");
      return {
        signal,
        threshold,
        inWindow,
        remaining: Math.max(0, threshold - inWindow),
        severity,
        source: "runtime_metrics"
      };
    })
    .filter((entry) => entry.inWindow >= entry.threshold);

  const malformedSignals = [
    "outbound_integration_idempotency_key_invalid_format_blocked",
    "outbound_integration_idempotency_key_invalid_chars_blocked"
  ];
  const malformedInWindow = malformedSignals.reduce((acc, signal) => {
    const hits = integrationHardeningSignalBuckets.get(signal) || [];
    return acc + hits.filter((ts) => now - ts < INTEGRATION_HARDENING_ALERT_WINDOW_MS).length;
  }, 0);
  const malformedThreshold = 4;

  if (malformedInWindow >= malformedThreshold) {
    pendingAlerts.push({
      signal: "outbound_integration_idempotency_key_malformed_spike",
      threshold: malformedThreshold,
      inWindow: malformedInWindow,
      remaining: 0,
      severity: malformedInWindow >= malformedThreshold * 2 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      includes: malformedSignals
    } as any);
  }

  const mismatchSignals = [
    "outbound_integration_idempotency_key_mismatch_header_header_blocked",
    "outbound_integration_idempotency_key_mismatch_header_body_blocked"
  ];
  const mismatchInWindow = mismatchSignals.reduce((acc, signal) => {
    const hits = integrationHardeningSignalBuckets.get(signal) || [];
    return acc + hits.filter((ts) => now - ts < INTEGRATION_HARDENING_ALERT_WINDOW_MS).length;
  }, 0);
  const mismatchThreshold = 3;

  if (mismatchInWindow >= mismatchThreshold) {
    pendingAlerts.push({
      signal: "outbound_integration_idempotency_key_mismatch_spike",
      threshold: mismatchThreshold,
      inWindow: mismatchInWindow,
      remaining: 0,
      severity: mismatchInWindow >= mismatchThreshold * 2 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      includes: mismatchSignals
    } as any);
  }

  const weakSignals = [
    "outbound_integration_idempotency_key_too_short_blocked",
    "outbound_integration_idempotency_key_too_weak_blocked",
    "outbound_integration_idempotency_key_timestamp_only_blocked",
    "outbound_integration_idempotency_key_placeholder_blocked"
  ];
  const weakInWindow = weakSignals.reduce((acc, signal) => {
    const hits = integrationHardeningSignalBuckets.get(signal) || [];
    return acc + hits.filter((ts) => now - ts < INTEGRATION_HARDENING_ALERT_WINDOW_MS).length;
  }, 0);
  const weakThreshold = 3;

  if (weakInWindow >= weakThreshold) {
    pendingAlerts.push({
      signal: "outbound_integration_idempotency_key_weak_spike",
      threshold: weakThreshold,
      inWindow: weakInWindow,
      remaining: 0,
      severity: weakInWindow >= weakThreshold * 2 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      includes: weakSignals
    } as any);
  }

  const duplicateReplayed = Number(integrationHardeningCounters.get("outbound.duplicate_replayed") || 0);
  const duplicateInflightBlocked = Number(integrationHardeningCounters.get("outbound.duplicate_inflight_blocked") || 0);
  const sendAttemptAccepted = Number(integrationHardeningCounters.get("outbound.send_attempt_accepted") || 0);
  const duplicateObserved = duplicateReplayed + duplicateInflightBlocked + sendAttemptAccepted;
  const duplicateReplayRate = duplicateObserved > 0 ? duplicateReplayed / duplicateObserved : 0;

  if (duplicateObserved >= 20 && duplicateReplayRate >= 0.2) {
    pendingAlerts.push({
      signal: "outbound_integration_duplicate_replay_rate_high",
      threshold: 0.2,
      inWindow: Number(duplicateReplayRate.toFixed(4)),
      remaining: 0,
      severity: duplicateReplayRate >= 0.35 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      sampleSize: duplicateObserved,
      breakdown: {
        duplicateReplayed,
        duplicateInflightBlocked,
        sendAttemptAccepted
      }
    } as any);
  }

  const duplicateInflightPressureObserved = duplicateInflightBlocked + sendAttemptAccepted;
  const duplicateInflightPressureRate = duplicateInflightPressureObserved > 0
    ? duplicateInflightBlocked / duplicateInflightPressureObserved
    : 0;
  const duplicateInflightStaleRecovered = Number(integrationHardeningCounters.get("outbound.duplicate_inflight_stale_recovered") || 0);
  const duplicateInflightStaleObserved = duplicateInflightStaleRecovered + duplicateInflightBlocked;
  const duplicateInflightStaleRecoveryRate = duplicateInflightStaleObserved > 0
    ? duplicateInflightStaleRecovered / duplicateInflightStaleObserved
    : 0;

  if (duplicateInflightPressureObserved >= 20 && duplicateInflightPressureRate >= 0.3) {
    pendingAlerts.push({
      signal: "outbound_integration_duplicate_inflight_pressure_high",
      threshold: 0.3,
      inWindow: Number(duplicateInflightPressureRate.toFixed(4)),
      remaining: 0,
      severity: duplicateInflightPressureRate >= 0.5 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      sampleSize: duplicateInflightPressureObserved,
      breakdown: {
        duplicateInflightBlocked,
        sendAttemptAccepted
      }
    } as any);
  }

  const replayGuardReservationConflict = Number(integrationHardeningCounters.get("outbound.replay_guard_reservation_conflict") || 0);
  const replayGuardReservationObserved = replayGuardReservationConflict + sendAttemptAccepted;
  const replayGuardReservationConflictRate = replayGuardReservationObserved > 0
    ? replayGuardReservationConflict / replayGuardReservationObserved
    : 0;

  if (replayGuardReservationObserved >= 20 && replayGuardReservationConflictRate >= 0.15) {
    pendingAlerts.push({
      signal: "outbound_integration_replay_guard_reservation_conflict_rate_high",
      threshold: 0.15,
      inWindow: Number(replayGuardReservationConflictRate.toFixed(4)),
      remaining: 0,
      severity: replayGuardReservationConflictRate >= 0.3 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      sampleSize: replayGuardReservationObserved,
      breakdown: {
        replayGuardReservationConflict,
        sendAttemptAccepted
      }
    } as any);
  }

  if (duplicateInflightStaleObserved >= 10 && duplicateInflightStaleRecoveryRate >= 0.15) {
    pendingAlerts.push({
      signal: "outbound_integration_duplicate_inflight_stale_recovery_rate_high",
      threshold: 0.15,
      inWindow: Number(duplicateInflightStaleRecoveryRate.toFixed(4)),
      remaining: 0,
      severity: duplicateInflightStaleRecoveryRate >= 0.3 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      sampleSize: duplicateInflightStaleObserved,
      breakdown: {
        duplicateInflightStaleRecovered,
        duplicateInflightBlocked
      }
    } as any);
  }

  const retryWithoutKeyBlocked = Number(integrationHardeningCounters.get("outbound.retry_idempotency_key_required_blocked") || 0);
  const retryKeyDisciplineObserved = retryWithoutKeyBlocked + sendAttemptAccepted;
  const retryWithoutKeyRate = retryKeyDisciplineObserved > 0
    ? retryWithoutKeyBlocked / retryKeyDisciplineObserved
    : 0;

  if (retryKeyDisciplineObserved >= 20 && retryWithoutKeyRate >= 0.1) {
    pendingAlerts.push({
      signal: "outbound_integration_retry_without_idempotency_key_rate_high",
      threshold: 0.1,
      inWindow: Number(retryWithoutKeyRate.toFixed(4)),
      remaining: 0,
      severity: retryWithoutKeyRate >= 0.2 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      sampleSize: retryKeyDisciplineObserved,
      breakdown: {
        retryWithoutKeyBlocked,
        sendAttemptAccepted
      }
    } as any);
  }

  const missingIdempotencyReplayBlocked = Number(integrationHardeningCounters.get("outbound.missing_idempotency_fingerprint_replay_blocked") || 0);
  const missingIdempotencyGuardReserved = Number(integrationHardeningCounters.get("outbound.missing_idempotency_fingerprint_guard_reserved") || 0);
  const missingIdempotencyObserved = missingIdempotencyReplayBlocked + missingIdempotencyGuardReserved;
  const missingIdempotencyReplayRate = missingIdempotencyObserved > 0
    ? missingIdempotencyReplayBlocked / missingIdempotencyObserved
    : 0;

  if (missingIdempotencyObserved >= 10 && missingIdempotencyReplayRate >= 0.25) {
    pendingAlerts.push({
      signal: "outbound_integration_missing_idempotency_retry_replay_rate_high",
      threshold: 0.25,
      inWindow: Number(missingIdempotencyReplayRate.toFixed(4)),
      remaining: 0,
      severity: missingIdempotencyReplayRate >= 0.45 ? "critical" : "warn",
      source: "runtime_metrics_derived",
      sampleSize: missingIdempotencyObserved,
      breakdown: {
        missingIdempotencyReplayBlocked,
        missingIdempotencyGuardReserved
      }
    } as any);
  }

  pendingAlerts.sort((a, b) => Number(b.inWindow || 0) - Number(a.inWindow || 0) || a.signal.localeCompare(b.signal));

  return {
    windowMs: INTEGRATION_HARDENING_ALERT_WINDOW_MS,
    pendingAlerts
  };
};

const normalizeIdempotencyKey = (raw: string): string => {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_\-.]/g, "")
    .slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
};

const hasInvalidIdempotencyChars = (raw: string): boolean => /[^a-zA-Z0-9:_\-.]/.test(String(raw || "").trim());

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
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;
  const compact = normalized.replace(/[:_\-.]/g, "");
  return /^\d{10,17}$/.test(compact);
};

const isRepeatedPattern = (value: string): boolean => {
  if (value.length < 8) return false;
  for (let size = 1; size <= Math.min(6, Math.floor(value.length / 2)); size++) {
    if (value.length % size !== 0) continue;
    const chunk = value.slice(0, size);
    if (chunk.repeat(value.length / size) === value) return true;
  }
  return false;
};

const isWeakIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;

  // low-entropy keys (single-char repeated) increase cross-request collision risk and can break safe retries
  if (new Set(normalized).size < 2) return true;

  // strip separators to catch weak synthetic keys like "12345678" or "abcdefghi"
  const compact = normalized.replace(/[:_\-.]/g, "");
  if (isMonotonicSequence(compact)) return true;

  // repeated chunks like "abcabcabc" or "12121212" are low-entropy and collision-prone
  if (isRepeatedPattern(compact)) return true;

  // raw unix timestamps are predictable and often reused in retries/concurrent workers
  if (/^\d{10,17}$/.test(compact)) return true;

  return false;
};

const isPlaceholderIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;

  const compact = normalized.replace(/[:_\-.]/g, "");
  const placeholders = new Set([
    "idempotency",
    "idempotencykey",
    "key",
    "requestid",
    "messageid",
    "retry",
    "test",
    "demo",
    "sample",
    "default"
  ]);

  return placeholders.has(compact);
};

const parseRetryAttempt = (raw: unknown): number | null => {
  if (raw === undefined || raw === null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > RETRY_ATTEMPT_VALID_MAX) return null;
  return rounded;
};

const resolveOutboundRetryAttemptMaxAccepted = (): number => {
  const raw = Number((getRuntimeSettings() as any)?.waOutboundRetryAttemptMaxAccepted);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(2, Math.min(100, Math.round(raw)));
};

const resolveRetryAttempt = (req: any): { retryAttempt: number | null; invalidRaw: string | null } => {
  const candidates = [
    req.headers?.["x-retry-attempt"],
    req.headers?.["retry-attempt"],
    req.headers?.["x-attempt"],
    req.body?.retryAttempt,
    req.body?.attempt
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const candidateRaw = String(candidate).trim();
    if (!candidateRaw) continue;

    const parsed = parseRetryAttempt(candidateRaw);
    if (parsed !== null) return { retryAttempt: parsed, invalidRaw: null };
    return { retryAttempt: null, invalidRaw: candidateRaw.slice(0, 80) };
  }

  return { retryAttempt: null, invalidRaw: null };
};

const computeDuplicateInflightRetryAfterMs = (retryAttempt: number | null): number => {
  const base = OUTBOUND_DUPLICATE_INFLIGHT_RETRY_AFTER_MS;
  const cappedAttempt = Math.max(1, Math.min(6, Number(retryAttempt || 1)));
  const runtimeMaxDelayMs = Math.max(
    base,
    Math.min(60000, Math.round(Number((getRuntimeSettings() as any)?.waOutboundRetryMaxDelayMs || 10000)))
  );
  const raw = base * (2 ** (cappedAttempt - 1));
  return Math.max(base, Math.min(runtimeMaxDelayMs, raw));
};

const respondDuplicateInflight = (res: any, idempotencyKeyUsed: boolean, retryAttempt: number | null) => {
  const retryAfterMs = computeDuplicateInflightRetryAfterMs(retryAttempt);
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(202).json({
    ok: true,
    processing: true,
    duplicate: true,
    idempotencyKeyUsed,
    dedupReason: "inflight",
    retryAfterMs,
    suggestedRetryAttempt: Math.min(RETRY_ATTEMPT_VALID_MAX, retryAttempt !== null ? retryAttempt + 1 : 2)
  });
};

integrationRoutes.use(integrationAuth);

integrationRoutes.post("/leads", featureGate("integrations_api"), async (req: any, res) => {
  const companyId = Number(req.integrationCompanyId);

  const {
    whatsappId,
    name,
    number,
    email,
    source,
    notes,
    metadata
  } = req.body || {};

  const result = await CreateLeadService({
    companyId,
    whatsappId,
    name,
    number,
    email,
    source,
    notes,
    metadata
  });

  await incrementUsage(companyId, "integrations.leads_created", 1);
  return res.status(201).json(result);
});

integrationRoutes.post("/messages", featureGate("integrations_api"), async (req: any, res) => {
  const companyId = Number(req.integrationCompanyId);

  const { whatsappId, to, text, contactName, idempotencyKey } = req.body || {};
  const idempotencyHeaderXRaw = String(req.headers?.["x-idempotency-key"] || "").trim();
  const idempotencyHeaderStdRaw = String(req.headers?.["idempotency-key"] || "").trim();
  const idempotencyBodyRaw = String(idempotencyKey || "").trim();
  const idempotencyHeaderX = normalizeIdempotencyKey(idempotencyHeaderXRaw);
  const idempotencyHeaderStd = normalizeIdempotencyKey(idempotencyHeaderStdRaw);
  const idempotencyBody = normalizeIdempotencyKey(idempotencyBodyRaw);

  if (idempotencyHeaderXRaw && idempotencyHeaderXRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_long_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_long_blocked", 3);
    return res.status(400).json({ error: `x-idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderStdRaw && idempotencyHeaderStdRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_long_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_long_blocked", 3);
    return res.status(400).json({ error: `idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyBodyRaw && idempotencyBodyRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_long_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_long_blocked", 3);
    return res.status(400).json({ error: `body.idempotencyKey too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderXRaw && hasInvalidIdempotencyChars(idempotencyHeaderXRaw)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_invalid_chars_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_invalid_chars_blocked", 3);
    return res.status(400).json({ error: "x-idempotency-key contains invalid characters" });
  }

  if (idempotencyHeaderStdRaw && hasInvalidIdempotencyChars(idempotencyHeaderStdRaw)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_invalid_chars_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_invalid_chars_blocked", 3);
    return res.status(400).json({ error: "idempotency-key contains invalid characters" });
  }

  if (idempotencyBodyRaw && hasInvalidIdempotencyChars(idempotencyBodyRaw)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_invalid_chars_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_invalid_chars_blocked", 3);
    return res.status(400).json({ error: "body.idempotencyKey contains invalid characters" });
  }

  if (idempotencyHeaderXRaw && !idempotencyHeaderX) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_invalid_format_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_invalid_format_blocked", 3);
    return res.status(400).json({ error: "x-idempotency-key inválido" });
  }

  if (idempotencyHeaderStdRaw && !idempotencyHeaderStd) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_invalid_format_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_invalid_format_blocked", 3);
    return res.status(400).json({ error: "idempotency-key inválido" });
  }

  if (idempotencyBodyRaw && !idempotencyBody) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_invalid_format_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_invalid_format_blocked", 3);
    return res.status(400).json({ error: "body.idempotencyKey inválido" });
  }

  if (idempotencyHeaderX && idempotencyHeaderStd && idempotencyHeaderX !== idempotencyHeaderStd) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_mismatch_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_mismatch_blocked", 3);
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_mismatch_header_header_blocked", 3);
    return res.status(400).json({ error: "idempotency key mismatch between x-idempotency-key and idempotency-key headers" });
  }

  const idempotencyHeader = idempotencyHeaderX || idempotencyHeaderStd;

  if (idempotencyHeader && idempotencyBody && idempotencyHeader !== idempotencyBody) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_mismatch_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_mismatch_blocked", 3);
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_mismatch_header_body_blocked", 3);
    return res.status(400).json({ error: "idempotency key mismatch between header and body" });
  }

  const effectiveIdempotencyKey = idempotencyHeader || idempotencyBody;
  const replayFingerprint = buildOutboundReplayFingerprint({ whatsappId, to, text, contactName });
  const replayGuardKey = effectiveIdempotencyKey ? `${companyId}:${effectiveIdempotencyKey}` : "";
  const retryAttemptResolution = resolveRetryAttempt(req);
  const retryAttempt = retryAttemptResolution.retryAttempt;
  const isExplicitRetry = retryAttempt !== null && retryAttempt > 1;

  if (retryAttemptResolution.invalidRaw) {
    bumpIntegrationHardeningMetric("outbound.retry_attempt_invalid_blocked");
    pushIntegrationHardeningSignal("outbound_integration_retry_attempt_invalid_blocked", 3);
    return res.status(400).json({
      error: `retryAttempt invalid (allowed integer range: 1..${RETRY_ATTEMPT_VALID_MAX})`,
      retryAttempt: retryAttemptResolution.invalidRaw
    });
  }

  const retryAttemptMaxAccepted = resolveOutboundRetryAttemptMaxAccepted();
  if (retryAttempt !== null && retryAttempt > retryAttemptMaxAccepted) {
    bumpIntegrationHardeningMetric("outbound.retry_attempt_above_max_blocked");
    pushIntegrationHardeningSignal("outbound_integration_retry_attempt_above_max_blocked", 2);
    return res.status(400).json({
      error: `retryAttempt too high (max ${retryAttemptMaxAccepted})`,
      retryAttempt,
      retryAttemptMaxAccepted
    });
  }

  if (resolveOutboundRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_required_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_required_blocked", 2);
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required by hardening" });
  }

  if (isExplicitRetry && resolveOutboundRetryRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    bumpIntegrationHardeningMetric("outbound.retry_idempotency_key_required_blocked");
    pushIntegrationHardeningSignal("outbound_integration_retry_idempotency_key_required_blocked", 1);
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required for safe retries (retryAttempt > 1)" });
  }

  if (!effectiveIdempotencyKey && isExplicitRetry) {
    const noKeyReplayGuardKey = `${companyId}:${replayFingerprint}`;
    pruneOutboundNoKeyFingerprintGuard();
    const existingNoKeyGuard = outboundNoKeyFingerprintGuard.get(noKeyReplayGuardKey);

    if (existingNoKeyGuard) {
      bumpIntegrationHardeningMetric("outbound.missing_idempotency_fingerprint_replay_blocked");
      pushIntegrationHardeningSignal("outbound_integration_missing_idempotency_fingerprint_replay_blocked", 2);
      return res.status(409).json({
        error: "duplicate outbound retry detected without idempotency key; provide x-idempotency-key for safe retries",
        duplicate: true,
        idempotencyKeyUsed: false
      });
    }

    outboundNoKeyFingerprintGuard.set(noKeyReplayGuardKey, { createdAt: Date.now() });
    bumpIntegrationHardeningMetric("outbound.missing_idempotency_fingerprint_guard_reserved");
    bumpIntegrationHardeningMetric("outbound.retry_without_idempotency_fingerprint_guarded");
    pushIntegrationHardeningSignal("outbound_integration_retry_without_idempotency_fingerprint_guarded", 2);
  }

  if (effectiveIdempotencyKey && effectiveIdempotencyKey.length < resolveOutboundIdempotencyKeyMinLength()) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_short_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_short_blocked", 3);
    return res.status(400).json({
      error: `x-idempotency-key too short (min ${resolveOutboundIdempotencyKeyMinLength()})`
    });
  }

  if (effectiveIdempotencyKey && isTimestampOnlyIdempotencyKey(effectiveIdempotencyKey)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_timestamp_only_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_timestamp_only_blocked", 2);
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_weak_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_weak_blocked", 3);
    return res.status(400).json({
      error: "x-idempotency-key timestamp-only not allowed (use UUID/ULID or high-entropy key)"
    });
  }

  if (effectiveIdempotencyKey && isWeakIdempotencyKey(effectiveIdempotencyKey)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_weak_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_weak_blocked", 3);
    return res.status(400).json({
      error: "x-idempotency-key too weak (use at least 2 distinct, non-sequential characters)"
    });
  }

  if (effectiveIdempotencyKey && isPlaceholderIdempotencyKey(effectiveIdempotencyKey)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_placeholder_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_placeholder_blocked", 3);
    return res.status(400).json({
      error: "x-idempotency-key generic placeholder not allowed (use unique UUID/ULID per logical send)"
    });
  }

  if (replayGuardKey) {
    let replayGuardInfraFailed = false;

    try {
      const persistentExisting = await getOutboundReplayGuardPersistent(companyId, effectiveIdempotencyKey);

      if (persistentExisting) {
        if (persistentExisting.fingerprint !== replayFingerprint) {
          bumpIntegrationHardeningMetric("outbound.idempotency_key_payload_conflict_blocked");
          pushIntegrationHardeningSignal("outbound_integration_idempotency_key_payload_conflict_blocked", 2);
          return res.status(409).json({
            error: "idempotency key reuse with different payload is not allowed",
            idempotencyKey: effectiveIdempotencyKey
          });
        }

        if (persistentExisting.state === "done" && persistentExisting.response) {
          bumpIntegrationHardeningMetric("outbound.duplicate_replayed");
          bumpIntegrationHardeningMetric("outbound.duplicate_replayed_source.persistent");
          pushIntegrationHardeningSignal("outbound_integration_duplicate_replayed", 25);
          return res.status(200).json({
            ...persistentExisting.response,
            duplicate: true,
            replayed: true,
            idempotencyKeyUsed: true
          });
        }

        const persistentInflightAgeMs = persistentExisting.createdAtMs > 0
          ? Math.max(0, Date.now() - persistentExisting.createdAtMs)
          : 0;
        const persistentInflightStale = persistentInflightAgeMs >= OUTBOUND_REPLAY_GUARD_INFLIGHT_STALE_MS;

        if (!persistentInflightStale) {
          bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked");
          bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked_source.persistent");
          pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_blocked", 10);
          return respondDuplicateInflight(res, true, retryAttempt);
        }

        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_stale_recovered");
        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_stale_recovered_source.persistent");
        pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_stale_recovered", 2);
        await clearOutboundReplayGuardPersistent(companyId, effectiveIdempotencyKey);
        outboundReplayGuard.delete(replayGuardKey);
      }

      const persistentReserved = await tryReserveOutboundReplayGuardPersistentInflight(companyId, effectiveIdempotencyKey, replayFingerprint);
      if (!persistentReserved) {
        bumpIntegrationHardeningMetric("outbound.replay_guard_reservation_conflict");
        pushIntegrationHardeningSignal("outbound_integration_replay_guard_reservation_conflict", 1);

        const racedExisting = await getOutboundReplayGuardPersistent(companyId, effectiveIdempotencyKey);
        if (racedExisting) {
          if (racedExisting.fingerprint !== replayFingerprint) {
            bumpIntegrationHardeningMetric("outbound.idempotency_key_payload_conflict_blocked");
            pushIntegrationHardeningSignal("outbound_integration_idempotency_key_payload_conflict_blocked", 2);
            return res.status(409).json({
              error: "idempotency key reuse with different payload is not allowed",
              idempotencyKey: effectiveIdempotencyKey
            });
          }

          if (racedExisting.state === "done" && racedExisting.response) {
            bumpIntegrationHardeningMetric("outbound.replay_guard_reservation_conflict_outcome.replayed");
            bumpIntegrationHardeningMetric("outbound.duplicate_replayed");
            bumpIntegrationHardeningMetric("outbound.duplicate_replayed_source.persistent");
            pushIntegrationHardeningSignal("outbound_integration_duplicate_replayed", 25);
            return res.status(200).json({
              ...racedExisting.response,
              duplicate: true,
              replayed: true,
              idempotencyKeyUsed: true
            });
          }
        }

        bumpIntegrationHardeningMetric("outbound.replay_guard_reservation_conflict_outcome.processing");
        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked");
        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked_source.persistent");
        pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_blocked", 10);
        return respondDuplicateInflight(res, true, retryAttempt);
      }
    } catch {
      replayGuardInfraFailed = true;
      bumpIntegrationHardeningMetric("outbound.replay_guard_infra_error");
      pushIntegrationHardeningSignal("outbound_integration_replay_guard_infra_error", 2);

      if (resolveOutboundReplayGuardFailClosed()) {
        bumpIntegrationHardeningMetric("outbound.replay_guard_fail_closed_blocked");
        pushIntegrationHardeningSignal("outbound_integration_replay_guard_fail_closed_blocked", 1);
        return res.status(503).json({
          error: "outbound replay guard unavailable (fail-closed)",
          idempotencyKey: effectiveIdempotencyKey
        });
      }
    }

    pruneOutboundReplayGuard();
    const existing = outboundReplayGuard.get(replayGuardKey);

    if (existing) {
      if (existing.fingerprint !== replayFingerprint) {
        bumpIntegrationHardeningMetric("outbound.idempotency_key_payload_conflict_blocked");
        pushIntegrationHardeningSignal("outbound_integration_idempotency_key_payload_conflict_blocked", 2);
        return res.status(409).json({
          error: "idempotency key reuse with different payload is not allowed",
          idempotencyKey: effectiveIdempotencyKey
        });
      }

      if (existing.state === "done" && existing.response) {
        bumpIntegrationHardeningMetric("outbound.duplicate_replayed");
        bumpIntegrationHardeningMetric("outbound.duplicate_replayed_source.memory");
        pushIntegrationHardeningSignal("outbound_integration_duplicate_replayed", 25);
        return res.status(200).json({
          ...existing.response,
          duplicate: true,
          replayed: true,
          idempotencyKeyUsed: true
        });
      }

      const memoryInflightAgeMs = Math.max(0, Date.now() - existing.createdAt);
      const memoryInflightStale = memoryInflightAgeMs >= OUTBOUND_REPLAY_GUARD_INFLIGHT_STALE_MS;

      if (!memoryInflightStale) {
        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked");
        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked_source.memory");
        pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_blocked", 10);
        return respondDuplicateInflight(res, true, retryAttempt);
      }

      bumpIntegrationHardeningMetric("outbound.duplicate_inflight_stale_recovered");
      bumpIntegrationHardeningMetric("outbound.duplicate_inflight_stale_recovered_source.memory");
      pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_stale_recovered", 2);
      outboundReplayGuard.delete(replayGuardKey);
    }

    outboundReplayGuard.set(replayGuardKey, {
      createdAt: Date.now(),
      fingerprint: replayFingerprint,
      state: "inflight"
    });
    enforceOutboundReplayGuardMemoryCapacity();

    if (replayGuardInfraFailed) {
      bumpIntegrationHardeningMetric("outbound.replay_guard_memory_fallback_used");
      pushIntegrationHardeningSignal("outbound_integration_replay_guard_memory_fallback_used", 1);
    }
  }

  bumpIntegrationHardeningMetric("outbound.send_attempt_accepted");
  pushIntegrationHardeningSignal("outbound_integration_send_attempt_accepted", 50);

  try {
    const result = await SendOutboundTextService({
      companyId,
      whatsappId,
      to,
      text,
      contactName,
      idempotencyKey: effectiveIdempotencyKey || undefined
    } as any);

    const responsePayload = { ...result, idempotencyKeyUsed: Boolean(effectiveIdempotencyKey) };

    if ((result as any)?.duplicate && (result as any)?.dedupReason === "recent_retry_window") {
      bumpIntegrationHardeningMetric("outbound.recent_retry_window_blocked");
      pushIntegrationHardeningSignal("outbound_integration_recent_retry_window_blocked", 3);
    }

    if (replayGuardKey) {
      outboundReplayGuard.set(replayGuardKey, {
        createdAt: Date.now(),
        fingerprint: replayFingerprint,
        state: "done",
        response: responsePayload
      });
      enforceOutboundReplayGuardMemoryCapacity();

      try {
        await markOutboundReplayGuardPersistentDone(companyId, effectiveIdempotencyKey, replayFingerprint, responsePayload);
      } catch {
        bumpIntegrationHardeningMetric("outbound.replay_guard_mark_done_infra_error");
        pushIntegrationHardeningSignal("outbound_integration_replay_guard_mark_done_infra_error", 2);
      }
    }

    await incrementUsage(companyId, "integrations.messages_sent", 1);
    return res.status(201).json(responsePayload);
  } catch (err: any) {
    if (replayGuardKey) {
      outboundReplayGuard.delete(replayGuardKey);

      try {
        await clearOutboundReplayGuardPersistent(companyId, effectiveIdempotencyKey);
      } catch {
        bumpIntegrationHardeningMetric("outbound.replay_guard_clear_infra_error");
        pushIntegrationHardeningSignal("outbound_integration_replay_guard_clear_infra_error", 2);
      }
    }

    bumpIntegrationHardeningMetric("outbound.send_attempt_failed");
    pushIntegrationHardeningSignal("outbound_integration_send_attempt_failed", 4);
    throw err;
  }
});

integrationRoutes.get("/messages/hardening-status", featureGate("integrations_api"), async (req: any, res) => {
  const companyId = Number(req.integrationCompanyId);
  const metrics = getIntegrationHardeningMetrics();
  const alerts = getIntegrationHardeningAlertSnapshot();
  const counters = (metrics as any)?.counters || {};

  const recommendations: string[] = [];

  const duplicateReplayRateAlert = Array.isArray((alerts as any)?.pendingAlerts)
    ? (alerts as any).pendingAlerts.find((a: any) => a?.signal === "outbound_integration_duplicate_replay_rate_high")
    : null;

  if (duplicateReplayRateAlert) {
    recommendations.push("High duplicate replay rate: ensure producer retries reuse the same stable idempotency key per logical send and avoid blind retry loops.");
  }

  const duplicateInflightPressureAlert = Array.isArray((alerts as any)?.pendingAlerts)
    ? (alerts as any).pendingAlerts.find((a: any) => a?.signal === "outbound_integration_duplicate_inflight_pressure_high")
    : null;

  if (duplicateInflightPressureAlert) {
    recommendations.push("High inflight duplicate pressure: add jittered exponential backoff and cap concurrent retries per idempotency key to reduce duplicate collisions while previous sends are still processing.");
  }

  const replayGuardReservationConflictRateAlert = Array.isArray((alerts as any)?.pendingAlerts)
    ? (alerts as any).pendingAlerts.find((a: any) => a?.signal === "outbound_integration_replay_guard_reservation_conflict_rate_high")
    : null;

  if (replayGuardReservationConflictRateAlert) {
    recommendations.push("High replay-guard reservation conflict rate: reduce parallel retries per logical send (single-flight per idempotency key) and add small random retry jitter to prevent same-key worker stampedes.");
  }

  const duplicateInflightStaleRecoveryRateAlert = Array.isArray((alerts as any)?.pendingAlerts)
    ? (alerts as any).pendingAlerts.find((a: any) => a?.signal === "outbound_integration_duplicate_inflight_stale_recovery_rate_high")
    : null;

  if (duplicateInflightStaleRecoveryRateAlert) {
    recommendations.push("High stale inflight recovery rate: increase provider timeout budget and tune worker retry backoff/concurrency so inflight sends can settle before retries re-enter.");
  }

  const retryWithoutKeyRateAlert = Array.isArray((alerts as any)?.pendingAlerts)
    ? (alerts as any).pendingAlerts.find((a: any) => a?.signal === "outbound_integration_retry_without_idempotency_key_rate_high")
    : null;

  if (retryWithoutKeyRateAlert) {
    recommendations.push("High retry-without-key rate: persist one stable x-idempotency-key per logical outbound send and reuse it for every retry attempt (transport timeout, 5xx, or connection reset).");
  }

  const retryNoKeyReplayBlockedAlert = Array.isArray((alerts as any)?.pendingAlerts)
    ? (alerts as any).pendingAlerts.find((a: any) => a?.signal === "outbound_integration_missing_idempotency_fingerprint_replay_blocked")
    : null;

  if (retryNoKeyReplayBlockedAlert) {
    recommendations.push("Duplicate retries without idempotency key were blocked by fallback fingerprint guard: make client retries reuse a stable x-idempotency-key to avoid 409 duplicate blocks.");
  }

  if (Number(counters["outbound.retry_idempotency_key_required_blocked"] || 0) > 0) {
    recommendations.push("Some retry attempts were blocked due to missing idempotency key: set x-idempotency-key on initial request and persist it across retries.");
  }

  if (Number(counters["outbound.recent_retry_window_blocked"] || 0) > 0) {
    recommendations.push("Recent retry-window duplicates were blocked: audit producer retry pacing and ensure a single retry chain per logical send (avoid parallel workers re-sending the same payload). ");
  }

  if (Number(counters["outbound.retry_attempt_invalid_blocked"] || 0) > 0) {
    recommendations.push("Invalid retryAttempt values were blocked: send a strict integer between 1 and 1000 in retry headers/body to avoid bypassing retry hardening rules.");
  }

  if (Number(counters["outbound.retry_attempt_above_max_blocked"] || 0) > 0) {
    recommendations.push("Some retry attempts exceeded the accepted ceiling: cap producer retries and use jittered backoff; tune waOutboundRetryAttemptMaxAccepted only if your transport genuinely needs more attempts.");
  }

  if (Number(counters["outbound.idempotency_key_payload_conflict_blocked"] || 0) > 0) {
    recommendations.push("Idempotency key payload conflicts detected: never reuse the same key for different (to/text/contactName/whatsappId) payloads.");
  }

  if (Number(counters["outbound.idempotency_key_placeholder_blocked"] || 0) > 0) {
    recommendations.push("Generic placeholder idempotency keys were blocked: generate a unique UUID/ULID per logical outbound send and persist it across retries only for that same payload.");
  }

  if (Number(counters["outbound.replay_guard_infra_error"] || 0) > 0) {
    recommendations.push("Replay-guard storage had infra errors: check DB availability/latency for ai_integration_outbound_replay_guard.");
  }

  if (Number(counters["outbound.replay_guard_fail_closed_blocked"] || 0) > 0) {
    recommendations.push("Fail-closed replay-guard blocked outbound sends while persistence was unavailable: restore DB health first, then retry with the same idempotency key to avoid duplicates.");
  }

  if (Number(counters["outbound.replay_guard_memory_fallback_used"] || 0) > 0) {
    recommendations.push("Replay-guard fallback to in-memory mode was used: restore DB persistence for ai_integration_outbound_replay_guard to keep idempotency protection across restarts.");
  }

  if (Number(counters["outbound.replay_guard_memory_evicted"] || 0) > 0) {
    recommendations.push("Replay-guard in-memory entries were evicted due to capacity: increase waOutboundReplayGuardMemoryMaxEntries or restore DB-backed replay guard to preserve dedupe coverage.");
  }

  if (Number(counters["outbound.replay_guard_mark_done_infra_error"] || 0) > 0) {
    recommendations.push("Replay-guard failed to persist DONE state after a send: investigate DB/write errors to avoid duplicate replays after worker restarts.");
  }

  if (Number(counters["outbound.replay_guard_clear_infra_error"] || 0) > 0) {
    recommendations.push("Replay-guard failed to clear idempotency entries after failed sends: check DB deletes/locks to prevent stale inflight blocking.");
  }

  if (Number(counters["outbound.duplicate_inflight_stale_recovered"] || 0) > 0) {
    recommendations.push("Stale inflight recoveries observed: review worker/provider latency if sends frequently exceed stale inflight threshold.");
  }

  const replayGuardReservationConflict = Number(counters["outbound.replay_guard_reservation_conflict"] || 0);
  const replayGuardReservationConflictOutcomeReplayed = Number(counters["outbound.replay_guard_reservation_conflict_outcome.replayed"] || 0);
  const replayGuardReservationConflictOutcomeProcessing = Number(counters["outbound.replay_guard_reservation_conflict_outcome.processing"] || 0);

  return res.json({
    ok: true,
    companyId,
    hardening: {
      metrics,
      alerts,
      summary: {
        replayGuardReservationConflict,
        replayGuardReservationConflictOutcomeReplayed,
        replayGuardReservationConflictOutcomeProcessing
      },
      recommendations
    }
  });
});

export default integrationRoutes;
