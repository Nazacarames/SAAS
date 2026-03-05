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

const bumpIntegrationHardeningMetric = (metric: string, by = 1): void => {
  const next = (integrationHardeningCounters.get(metric) || 0) + by;
  integrationHardeningCounters.set(metric, next);
  integrationHardeningLastAt.set(metric, new Date().toISOString());
};

export const getIntegrationHardeningMetrics = () => ({
  counters: Object.fromEntries(Array.from(integrationHardeningCounters.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
  lastSeenAt: Object.fromEntries(Array.from(integrationHardeningLastAt.entries()).sort((a, b) => a[0].localeCompare(b[0])))
});

const normalizeIdempotencyKey = (raw: string): string => {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_\-.]/g, "")
    .slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
};

const hasInvalidIdempotencyChars = (raw: string): boolean => /[^a-zA-Z0-9:_\-.]/.test(String(raw || "").trim());

const isWeakIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;
  // low-entropy keys (single-char repeated) increase cross-request collision risk and can break safe retries
  return new Set(normalized).size < 2;
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
    return res.status(400).json({ error: `x-idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderStdRaw && idempotencyHeaderStdRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ error: `idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyBodyRaw && idempotencyBodyRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ error: `body.idempotencyKey too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderXRaw && hasInvalidIdempotencyChars(idempotencyHeaderXRaw)) {
    return res.status(400).json({ error: "x-idempotency-key contains invalid characters" });
  }

  if (idempotencyHeaderStdRaw && hasInvalidIdempotencyChars(idempotencyHeaderStdRaw)) {
    return res.status(400).json({ error: "idempotency-key contains invalid characters" });
  }

  if (idempotencyBodyRaw && hasInvalidIdempotencyChars(idempotencyBodyRaw)) {
    return res.status(400).json({ error: "body.idempotencyKey contains invalid characters" });
  }

  if (idempotencyHeaderXRaw && !idempotencyHeaderX) {
    return res.status(400).json({ error: "x-idempotency-key inválido" });
  }

  if (idempotencyHeaderStdRaw && !idempotencyHeaderStd) {
    return res.status(400).json({ error: "idempotency-key inválido" });
  }

  if (idempotencyBodyRaw && !idempotencyBody) {
    return res.status(400).json({ error: "body.idempotencyKey inválido" });
  }

  if (idempotencyHeaderX && idempotencyHeaderStd && idempotencyHeaderX !== idempotencyHeaderStd) {
    return res.status(400).json({ error: "idempotency key mismatch between x-idempotency-key and idempotency-key headers" });
  }

  const idempotencyHeader = idempotencyHeaderX || idempotencyHeaderStd;

  if (idempotencyHeader && idempotencyBody && idempotencyHeader !== idempotencyBody) {
    return res.status(400).json({ error: "idempotency key mismatch between header and body" });
  }

  const effectiveIdempotencyKey = idempotencyHeader || idempotencyBody;

  if (resolveOutboundRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required by hardening" });
  }

  if (resolveOutboundRetryRequireIdempotencyKey() && !effectiveIdempotencyKey) {
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required for safe retries" });
  }

  if (effectiveIdempotencyKey && effectiveIdempotencyKey.length < resolveOutboundIdempotencyKeyMinLength()) {
    return res.status(400).json({
      error: `x-idempotency-key too short (min ${resolveOutboundIdempotencyKeyMinLength()})`
    });
  }

  if (effectiveIdempotencyKey && isWeakIdempotencyKey(effectiveIdempotencyKey)) {
    bumpIntegrationHardeningMetric("outbound.idempotency_key_too_weak_blocked");
    return res.status(400).json({
      error: "x-idempotency-key too weak (use at least 2 distinct characters)"
    });
  }

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
});

export default integrationRoutes;
