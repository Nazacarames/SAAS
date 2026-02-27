import { Router } from "express";
import integrationAuth from "../../middleware/integrationAuth";
import CreateLeadService from "../../services/IntegrationServices/CreateLeadService";
import SendOutboundTextService from "../../services/IntegrationServices/SendOutboundTextService";

const integrationRoutes = Router();

// All integration endpoints are protected by x-api-key
integrationRoutes.use(integrationAuth);

// Create lead from external platform
integrationRoutes.post("/leads", async (req: any, res) => {
  const companyId = 1; // single-tenant MVP

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

  return res.status(201).json(result);
});

// Send message (outbound) from external platform
integrationRoutes.post("/messages", async (req: any, res) => {
  const companyId = 1; // single-tenant MVP

  const { whatsappId, to, text, contactName } = req.body || {};

  const result = await SendOutboundTextService({
    companyId,
    whatsappId,
    to,
    text,
    contactName
  });

  return res.status(201).json(result);
});

export default integrationRoutes;
