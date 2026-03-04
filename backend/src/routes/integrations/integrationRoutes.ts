import { Router } from "express";
import integrationAuth from "../../middleware/integrationAuth";
import CreateLeadService from "../../services/IntegrationServices/CreateLeadService";
import SendOutboundTextService from "../../services/IntegrationServices/SendOutboundTextService";

const integrationRoutes = Router();

integrationRoutes.use(integrationAuth);

integrationRoutes.post("/leads", async (req: any, res) => {
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

  return res.status(201).json(result);
});

integrationRoutes.post("/messages", async (req: any, res) => {
  const companyId = Number(req.integrationCompanyId);

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
