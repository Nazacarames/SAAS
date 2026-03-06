import { Router } from "express";
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

const isWeakIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;

  // low-entropy keys (single-char repeated) increase cross-request collision risk and can break safe retries
  if (new Set(normalized).size < 2) return true;

  // strip separators to catch weak synthetic keys like "12345678" or "abcdefghi"
  const compact = normalized.replace(/[:_\-.]/g, "");
  if (isMonotonicSequence(compact)) return true;

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

  if (effectiveIdempotencyKey && isWeakIdempotencyKey(effectiveIdempotencyKey)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_weak_blocked");
    pushIntegrationHardeningSignal("outbound_integration_idempotency_key_too_weak_blocked", 3);
    return res.status(400).json({
      error: "x-idempotency-key too weak (use at least 2 distinct, non-sequential characters)"
    });
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

    await incrementUsage(companyId, "integrations.messages_sent", 1);
    return res.status(201).json({ ...result, idempotencyKeyUsed: Boolean(effectiveIdempotencyKey) });
  } catch (err: any) {
    bumpIntegrationHardeningMetric("outbound.send_attempt_failed");
    pushIntegrationHardeningSignal("outbound_integration_send_attempt_failed", 4);
    throw err;
  }
});

export default integrationRoutes;
