import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = (() => {
  const raw = Number(process.env.BASIC_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : 180;
})();
const MAX_BUCKETS = 50_000;
const CLEANUP_INTERVAL = 120_000;
let lastCleanup = Date.now();

const isPublicPath = (path: string) =>
  path.startsWith("/api/integrations") ||
  path.startsWith("/api/ai/meta-leads/webhook") ||
  path.startsWith("/api/meta") ||
  path.startsWith("/api/webhooks") ||
  path.startsWith("/health");

const cleanupBuckets = (now: number) => {
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, val] of buckets) {
    if (val.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) buckets.clear();
};

export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const requestId = String(req.header("x-request-id") || crypto.randomUUID());
  (req as any).requestId = requestId;
  res.setHeader("x-request-id", requestId);

  if (isPublicPath(req.path)) return next();

  const now = Date.now();
  cleanupBuckets(now);

  const key = `${req.ip}:${req.path}`;
  const item = buckets.get(key);

  if (!item || item.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (item.count >= MAX_PER_WINDOW) {
    return res.status(429).json({ error: "Too many requests", requestId });
  }

  item.count += 1;
  return next();
};
