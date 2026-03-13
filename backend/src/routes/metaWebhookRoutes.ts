import { Router } from "express";
import axios from "axios";
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import sequelize from "../database";

const metaWebhookRoutes = Router();

const META_REPLAY_TTL_MS = Number(process.env.META_WEBHOOK_REPLAY_TTL_MS || 10 * 60 * 1000);
const META_MAX_BODY_BYTES = Number(process.env.META_WEBHOOK_MAX_BODY_BYTES || 1_000_000);
const META_REPLAY_CACHE_MAX_ENTRIES = Math.max(500, Number(process.env.META_WEBHOOK_REPLAY_CACHE_MAX_ENTRIES || 20000));
const META_SIGNATURE_REQUIRED = !["0", "false", "no", "off"].includes(String(process.env.META_WEBHOOK_SIGNATURE_REQUIRED || "true").trim().toLowerCase());
const replayCache = new Map<string, number>();

const META_ALERT_WINDOW_MS = Math.max(60_000, Number(process.env.META_WEBHOOK_ALERT_WINDOW_MS || 10 * 60 * 1000));
const webhookCounters = new Map<string, number>();
const webhookLastAt = new Map<string, string>();
const webhookRecentEvents = new Map<string, number[]>();

const pruneRecentMetricEvents = (metric: string, now: number): number[] => {
  const keepFrom = now - META_ALERT_WINDOW_MS;
  const current = webhookRecentEvents.get(metric) || [];
  const pruned = current.filter(ts => ts >= keepFrom);
  webhookRecentEvents.set(metric, pruned);
  return pruned;
};

const bumpWebhookMetric = (metric: string, by = 1) => {
  const now = Date.now();
  webhookCounters.set(metric, (webhookCounters.get(metric) || 0) + by);
  webhookLastAt.set(metric, new Date(now).toISOString());

  const events = pruneRecentMetricEvents(metric, now);
  for (let i = 0; i < Math.max(1, by); i += 1) events.push(now);
  webhookRecentEvents.set(metric, events);
};

const enforceReplayCacheCapacity = () => {
  if (replayCache.size <= META_REPLAY_CACHE_MAX_ENTRIES) return;
  const overflow = replayCache.size - META_REPLAY_CACHE_MAX_ENTRIES;
  const keys = Array.from(replayCache.keys()).slice(0, overflow);
  for (const key of keys) replayCache.delete(key);
  if (keys.length > 0) bumpWebhookMetric("meta_webhook.replay_cache_evicted", keys.length);
};

export const getMetaWebhookMetrics = () => {
  const now = Date.now();
  const countersInWindow = Object.fromEntries(
    Array.from(webhookCounters.keys())
      .sort((a, b) => a.localeCompare(b))
      .map(metric => [metric, pruneRecentMetricEvents(metric, now).length])
  );

  return {
    counters: Object.fromEntries(Array.from(webhookCounters.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    countersInWindow,
    alertWindowMs: META_ALERT_WINDOW_MS,
    lastSeenAt: Object.fromEntries(Array.from(webhookLastAt.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    replayCacheSize: replayCache.size,
    replayCacheMaxEntries: META_REPLAY_CACHE_MAX_ENTRIES,
    replayTtlMs: META_REPLAY_TTL_MS,
    signatureRequired: META_SIGNATURE_REQUIRED
  };
};

export const getMetaWebhookAlerts = () => {
  const metrics = getMetaWebhookMetrics() as any;
  const countersInWindow = (metrics?.countersInWindow || {}) as Record<string, number>;
  const alertWindowMs = Number(metrics?.alertWindowMs || META_ALERT_WINDOW_MS);
  const alerts: Array<Record<string, unknown>> = [];

  const signatureRejected = Number(countersInWindow["meta_webhook.signature_rejected"] || 0);
  if (signatureRejected >= 5) {
    alerts.push({
      key: "meta_webhook_signature_rejected_spike",
      severity: signatureRejected >= 15 ? "critical" : "warn",
      value: signatureRejected,
      threshold: 5,
      windowMs: alertWindowMs
    });
  }

  const replayBlocked = Number(countersInWindow["meta_webhook.replay_blocked"] || 0);
  if (replayBlocked >= 10) {
    alerts.push({
      key: "meta_webhook_replay_blocked_spike",
      severity: replayBlocked >= 30 ? "critical" : "warn",
      value: replayBlocked,
      threshold: 10,
      windowMs: alertWindowMs
    });
  }

  const oversizeBlocked = Number(countersInWindow["meta_webhook.payload_too_large"] || 0);
  if (oversizeBlocked >= 3) {
    alerts.push({
      key: "meta_webhook_payload_too_large_spike",
      severity: oversizeBlocked >= 10 ? "critical" : "warn",
      value: oversizeBlocked,
      threshold: 3,
      windowMs: alertWindowMs
    });
  }

  return alerts;
};

const parseSignature = (headerValue: string): string => {
  const raw = String(headerValue || "").trim();
  if (!raw) return "";
  const [algo, digest] = raw.split("=");
  if (String(algo || "").toLowerCase() !== "sha256") return "";
  const normalized = String(digest || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
};

const getBodyBytes = (req: any): Buffer => {
  const raw = req?.rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  return Buffer.from(JSON.stringify(req.body || {}), "utf8");
};

const hasReplay = (replayKey: string, ttlMs: number): boolean => {
  const now = Date.now();
  let expiredCleaned = 0;

  for (const [k, exp] of replayCache.entries()) {
    if (exp <= now) {
      replayCache.delete(k);
      expiredCleaned += 1;
    }
  }
  if (expiredCleaned > 0) bumpWebhookMetric("meta_webhook.replay_cache_expired_cleaned", expiredCleaned);

  const currentExpiry = replayCache.get(replayKey) || 0;
  if (currentExpiry > now) {
    bumpWebhookMetric("meta_webhook.replay_blocked");
    return true;
  }

  replayCache.set(replayKey, now + Math.max(1000, ttlMs));
  enforceReplayCacheCapacity();
  bumpWebhookMetric("meta_webhook.replay_guard_reserved");
  return false;
};

// Facebook/Meta uses GET to verify, then POST to deliver events.
metaWebhookRoutes.get("/leadgen", async (req: any, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expected = process.env.META_VERIFY_TOKEN || "";

  if (mode === "subscribe" && expected && token === expected) {
    return res.status(200).send(String(challenge || ""));
  }

  return res.status(403).json({ error: "Verification failed" });
});

metaWebhookRoutes.post("/leadgen", async (req: any, res) => {
  bumpWebhookMetric("meta_webhook.request_total");

  const contentType = String(req.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    bumpWebhookMetric("meta_webhook.invalid_content_type");
    return res.status(415).json({ error: "Unsupported webhook Content-Type", expected: "application/json" });
  }

  const bodyBytes = getBodyBytes(req);
  if (bodyBytes.byteLength > META_MAX_BODY_BYTES) {
    bumpWebhookMetric("meta_webhook.payload_too_large");
    return res.status(413).json({ error: "Webhook payload too large" });
  }

  const payload = req.body || {};
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entry)) {
    bumpWebhookMetric("meta_webhook.invalid_payload");
    return res.status(400).json({ error: "Invalid webhook payload", reason: "entry_array_required" });
  }

  const appSecret = String(process.env.META_LEAD_ADS_APP_SECRET || process.env.META_APP_SECRET || "").trim();
  if (META_SIGNATURE_REQUIRED && !appSecret) {
    bumpWebhookMetric("meta_webhook.signature_secret_missing_blocked");
    return res.status(503).json({ error: "Webhook signature secret not configured" });
  }

  const signatureHeader = String(req.get("x-hub-signature-256") || "");
  if (appSecret) {
    const signature = parseSignature(signatureHeader);
    if (!signature) {
      bumpWebhookMetric("meta_webhook.signature_rejected");
      return res.status(401).json({ error: "Missing or malformed webhook signature" });
    }

    const expected = crypto.createHmac("sha256", appSecret).update(bodyBytes).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
      bumpWebhookMetric("meta_webhook.signature_rejected");
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    bumpWebhookMetric("meta_webhook.signature_verified");
  }

  const eventId = String(req.get("x-meta-event-id") || req.get("x-webhook-id") || "").trim();
  const replayDigest = crypto.createHash("sha256").update(bodyBytes).digest("hex");
  const replayKey = eventId ? `event:${eventId}` : `body:${replayDigest}`;
  if (hasReplay(replayKey, META_REPLAY_TTL_MS)) {
    return res.status(202).json({ ok: true, ignored: true, reason: "replay_blocked" });
  }

  // Determine company from payload or env default
  const companyId = Number(payload.companyId || process.env.META_DEFAULT_COMPANY_ID || 1);

  // --- Local processing: forward internally to the AI meta-leads handler ---
  // This ensures leads are created, contacts are stored, and welcome template
  // is sent even if n8n is unavailable.
  let localResult: any = null;
  try {
    const internalPayload = { ...payload, companyId };
    const internalResp = await fetch(
      `http://localhost:${process.env.PORT || 3001}/api/ai/meta-leads/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forward the original signature so the internal handler can verify
          ...(req.get("x-hub-signature-256") ? { "x-hub-signature-256": String(req.get("x-hub-signature-256")) } : {})
        },
        body: JSON.stringify(internalPayload)
      }
    );
    localResult = await internalResp.json().catch(() => null);
    bumpWebhookMetric("meta_webhook.local_process_ok");
  } catch (localErr: any) {
    bumpWebhookMetric("meta_webhook.local_process_failed");
    console.error("[meta-leadgen] local processing failed:", localErr?.message);
  }

  // --- Also forward to n8n if configured (best-effort, non-blocking for response) ---
  const target = process.env.META_N8N_WEBHOOK_URL || "";
  if (target) {
    axios.post(target, payload, {
      timeout: 15000,
      headers: { "content-type": "application/json" }
    }).then(() => {
      bumpWebhookMetric("meta_webhook.forward_ok");
    }).catch((e: any) => {
      bumpWebhookMetric("meta_webhook.forward_failed");
      console.error("[meta-leadgen] n8n forward failed:", e?.message);
    });
  }

  return res.status(200).json({
    ok: true,
    localProcessed: Boolean(localResult?.ok),
    localResult: localResult || null
  });
});

export default metaWebhookRoutes;
