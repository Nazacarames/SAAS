import { Router } from "express";
import isAuth from "../middleware/isAuth";
import ListWhatsappsService from "../services/WhatsappServices/ListWhatsappsService";
import CreateWhatsappService from "../services/WhatsappServices/CreateWhatsappService";
import ShowWhatsappService from "../services/WhatsappServices/ShowWhatsappService";
import DeleteWhatsappService from "../services/WhatsappServices/DeleteWhatsappService";
import validateSchema from "../middleware/validateSchema";
import { createWhatsappSchema } from "../schemas/whatsappSchemas";

const whatsappRoutes = Router();

whatsappRoutes.get("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const whatsapps = await ListWhatsappsService({ companyId });
  return res.json(whatsapps);
});

whatsappRoutes.post("/", isAuth, validateSchema(createWhatsappSchema), async (req: any, res) => {
  const { companyId } = req.user;
  const { name, isDefault } = req.body;

  const whatsapp = await CreateWhatsappService({
    name,
    companyId,
    isDefault
  });

  return res.status(201).json(whatsapp);
});

whatsappRoutes.get("/:whatsappId", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { whatsappId } = req.params;

  const whatsapp = await ShowWhatsappService({
    whatsappId: parseInt(whatsappId),
    companyId
  });

  return res.json(whatsapp);
});

whatsappRoutes.delete("/:whatsappId", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { whatsappId } = req.params;

  await DeleteWhatsappService({
    whatsappId: parseInt(whatsappId),
    companyId
  });

  return res.status(204).send();
});

export default whatsappRoutes;
