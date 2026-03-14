/**
 * Chatwoot Webhook Routes
 *
 * POST /webhook — Receives Chatwoot message_created events
 *                 and feeds them into the AI pipeline.
 */

import { Router, Request, Response } from "express";
import { processChatwootWebhook } from "../services/ChatwootServices/ProcessChatwootWebhookService";

const router = Router();

// ---------------------------------------------------------------------------
// POST /webhook — Chatwoot message_created webhook
// ---------------------------------------------------------------------------

router.post("/webhook", async (req: Request, res: Response) => {
  try {
    // Basic content-type validation
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return res.status(415).json({ error: "unsupported_media_type" });
    }

    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "invalid_payload" });
    }

    // Process asynchronously — return 200 immediately to avoid Chatwoot retries
    // while the AI agent is thinking (can take 5-25s).
    res.status(200).json({ ok: true });

    // Fire-and-forget: process the webhook in the background
    processChatwootWebhook(payload).catch((err) => {
      console.error("[chatwoot][route] webhook processing error:", err?.message || err);
    });
  } catch (err: any) {
    console.error("[chatwoot][route] unexpected error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error" });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /health — Simple health check for the Chatwoot channel
// ---------------------------------------------------------------------------

router.get("/health", (_req: Request, res: Response) => {
  const hasConfig = Boolean(
    process.env.CHATWOOT_API_URL &&
    process.env.CHATWOOT_ACCOUNT_ID &&
    process.env.CHATWOOT_API_TOKEN
  );
  res.json({
    status: hasConfig ? "ok" : "unconfigured",
    timestamp: new Date().toISOString(),
    channel: "chatwoot",
  });
});

export default router;
