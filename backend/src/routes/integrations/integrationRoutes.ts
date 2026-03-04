import { Router } from "express";
import integrationAuth from "../../middleware/integrationAuth";
import CreateLeadService from "../../services/IntegrationServices/CreateLeadService";
import SendOutboundTextService from "../../services/IntegrationServices/SendOutboundTextService";
import featureGate from "../../middleware/featureGate";
import { incrementUsage } from "../../services/BillingServices/BillingService";
import { getRuntimeSettings } from "../../services/SettingsServices/RuntimeSettingsService";

const integrationRoutes = Router();

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
  const idempotencyFromHeader = String(req.headers?.["x-idempotency-key"] || "").trim();
  const effectiveIdempotencyKey = String(idempotencyFromHeader || idempotencyKey || "").trim();

  const settings = getRuntimeSettings() as any;
  const retryRequiresIdempotency = Boolean(settings?.waOutboundRetryRequireIdempotencyKey);
  if (retryRequiresIdempotency && !effectiveIdempotencyKey) {
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required" });
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
