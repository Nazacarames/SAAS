import crypto from "crypto";
import { Router } from "express";
import { processCloudWebhookPayload, recordInboundSignatureInvalidBlocked } from "../services/WhatsAppCloudServices/ProcessCloudWebhookService";
import { getRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";

const whatsappCloudRoutes = Router();

const safeEqualHex = (a: string, b: string) => {
  try {
    const aa = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    if (aa.length === 0 || bb.length === 0 || aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
};

const verifyWebhookSignature = (req: any): boolean => {
  const secret = String(getRuntimeSettings().waCloudAppSecret || "").trim();
  if (!secret) return true; // If secret not configured, keep backward compatibility.

  const header = String(req.headers?.["x-hub-signature-256"] || "");
  if (!header.startsWith("sha256=")) return false;

  const provided = header.slice(7);
  const raw = typeof req.rawBody === "string"
    ? req.rawBody
    : Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString("utf8")
      : JSON.stringify(req.body || {});

  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return safeEqualHex(expected, provided);
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

whatsappCloudRoutes.post("/webhook", async (req: any, res) => {
  if (!verifyWebhookSignature(req)) {
    recordInboundSignatureInvalidBlocked({ hasSignatureHeader: Boolean(String(req.headers?.["x-hub-signature-256"] || "").trim()), appSecretConfigured: Boolean(String(getRuntimeSettings().waCloudAppSecret || "").trim()) });
    return res.status(401).json({ ok: false, error: "invalid_signature" });
  }
  const result = await processCloudWebhookPayload(req.body || {});
  return res.status(200).json({ ok: true, ...result });
});

// Admin-only helper to validate Cloud API credentials end-to-end (without exposing secrets).
whatsappCloudRoutes.post("/test-send", isAuth, isAdmin, async (req: any, res) => {
  const to = String(req.body?.to || "").replace(/\D/g, "");
  const text = String(req.body?.text || "").trim();

  if (!to || to.length < 8) return res.status(400).json({ error: "Missing/invalid 'to'" });
  if (!text) return res.status(400).json({ error: "Missing 'text'" });

  const settings = getRuntimeSettings();
  if (!settings.waCloudPhoneNumberId || !settings.waCloudAccessToken) {
    return res.status(400).json({ error: "Cloud API credentials missing" });
  }

  const url = "https://graph.facebook.com/v21.0/" + settings.waCloudPhoneNumberId + "/messages";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + settings.waCloudAccessToken
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });

  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return res.status(resp.status).json({ error: "WA Cloud send failed", details: data?.error?.message || data });
  }

  const messageId = data?.messages?.[0]?.id || null;
  return res.json({ ok: true, messageId });
});

export default whatsappCloudRoutes;
