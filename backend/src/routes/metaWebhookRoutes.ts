import { Router } from "express";
import axios from "axios";

const metaWebhookRoutes = Router();

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
  const target =
    process.env.META_N8N_WEBHOOK_URL ||
    "https://lmtmlatam.app.n8n.cloud/webhook/meta-leads";

  try {
    // Forward raw payload to n8n (n8n should use a POST Webhook trigger)
    const r = await axios.post(target, req.body, {
      timeout: 15000,
      headers: { "content-type": "application/json" }
    });

    return res.status(200).json({ ok: true, forwarded: true, status: r.status });
  } catch (e: any) {
    console.error("Meta forward failed:", e?.message);
    const status = e?.response?.status || 500;
    return res.status(200).json({ ok: false, forwarded: false, errorStatus: status });
  }
});

export default metaWebhookRoutes;
