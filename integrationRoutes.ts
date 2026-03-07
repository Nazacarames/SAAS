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

type OutboundReplayGuardEntry = {
  createdAt: number;
  fingerprint: string;
  state: "inflight" | "done";
  response?: any;
};

const outboundReplayGuard = new Map<string, OutboundReplayGuardEntry>();

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

const buildOutboundReplayFingerprint = (payload: any): string => {
  const whatsappId = String(payload?.whatsappId || "").trim().toLowerCase();
  const to = String(payload?.to || "").trim();
  const text = String(payload?.text || "").trim();
  const contactName = String(payload?.contactName || "").trim().toLowerCase();
  return `${whatsappId}|${to}|${text}|${contactName}`;
};

const upsertOutboundReplayGuardPersistentInflight = async (companyId: number, idempotencyKey: string, fingerprint: string): Promise<void> => {
  await ensureOutboundReplayGuardTable();
  await pruneOutboundReplayGuardPersistentIfDue();

  await sequelize.query(
    `INSERT INTO ai_integration_outbound_replay_guard (company_id, idempotency_key, fingerprint, state, response_json, created_at, updated_at)
     VALUES (:companyId, :idempotencyKey, :fingerprint, 'inflight', NULL, NOW(), NOW())
     ON CONFLICT (company_id, idempotency_key)
     DO UPDATE SET
       fingerprint = EXCLUDED.fingerprint,
       state = 'inflight',
       response_json = NULL,
       updated_at = NOW()`,
    {
      replacements: { companyId, idempotencyKey, fingerprint },
      type: QueryTypes.INSERT
    }
  );
};

const getOutboundReplayGuardPersistent = async (companyId: number, idempotencyKey: string): Promise<{ fingerprint: string; state: "inflight" | "done"; response?: any } | null> => {
  await ensureOutboundReplayGuardTable();
  await pruneOutboundReplayGuardPersistentIfDue();

  const rows: any[] = await sequelize.query(
    `SELECT fingerprint, state, response_json
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
    "outbound_integration_idempotency_key_timestamp_only_blocked"
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

  pendingAlerts.sort((a, b) => b.inWindow - a.inWindow || a.signal.localeCompare(b.signal));

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

const isWeakIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;

  // low-entropy keys (single-char repeated) increase cross-request collision risk and can break safe retries
  if (new Set(normalized).size < 2) return true;

  // strip separators to catch weak synthetic keys like "12345678" or "abcdefghi"
  const compact = normalized.replace(/[:_\-.]/g, "");
  if (isMonotonicSequence(compact)) return true;

  // raw unix timestamps are predictable and often reused in retries/concurrent workers
  if (/^\d{10,17}$/.test(compact)) return true;

  return false;
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

  if (resolveOutboundRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_required_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_required_blocked", 2);
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required by hardening" });
  }

  if (resolveOutboundRetryRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    bumpIntegrationHardeningMetric("outbound.retry_idempotency_key_required_blocked");
    pushIntegrationHardeningSignal("outbound_integration_retry_idempotency_key_required_blocked", 1);
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required for safe retries" });
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
          pushIntegrationHardeningSignal("outbound_integration_duplicate_replayed", 25);
          return res.status(200).json({
            ...persistentExisting.response,
            duplicate: true,
            replayed: true,
            idempotencyKeyUsed: true
          });
        }

        bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked");
        pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_blocked", 10);
        return res.status(202).json({
          ok: true,
          processing: true,
          duplicate: true,
          idempotencyKeyUsed: true
        });
      }

      await upsertOutboundReplayGuardPersistentInflight(companyId, effectiveIdempotencyKey, replayFingerprint);
    } catch {
      replayGuardInfraFailed = true;
      bumpIntegrationHardeningMetric("outbound.replay_guard_infra_error");
      pushIntegrationHardeningSignal("outbound_integration_replay_guard_infra_error", 2);
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
        pushIntegrationHardeningSignal("outbound_integration_duplicate_replayed", 25);
        return res.status(200).json({
          ...existing.response,
          duplicate: true,
          replayed: true,
          idempotencyKeyUsed: true
        });
      }

      bumpIntegrationHardeningMetric("outbound.duplicate_inflight_blocked");
      pushIntegrationHardeningSignal("outbound_integration_duplicate_inflight_blocked", 10);
      return res.status(202).json({
        ok: true,
        processing: true,
        duplicate: true,
        idempotencyKeyUsed: true
      });
    }

    outboundReplayGuard.set(replayGuardKey, {
      createdAt: Date.now(),
      fingerprint: replayFingerprint,
      state: "inflight"
    });

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

    if (replayGuardKey) {
      outboundReplayGuard.set(replayGuardKey, {
        createdAt: Date.now(),
        fingerprint: replayFingerprint,
        state: "done",
        response: responsePayload
      });

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

export default integrationRoutes;
