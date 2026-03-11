import { Router } from "express";
import isAuth from "../middleware/isAuth";
import ListContactsService from "../services/ContactServices/ListContactsService";
import CreateContactService from "../services/ContactServices/CreateContactService";
import UpdateContactService from "../services/ContactServices/UpdateContactService";
import DeleteContactService from "../services/ContactServices/DeleteContactService";
import SendMessageToContactService from "../services/ContactServices/SendMessageToContactService";
import Contact from "../models/Contact";
import AppError from "../errors/AppError";

const contactRoutes = Router();

contactRoutes.get("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { status, assignedUserId } = req.query as any;
  const contacts = await ListContactsService({ companyId, status, assignedUserId: assignedUserId === undefined ? undefined : (assignedUserId === "null" ? null : Number(assignedUserId)) });
  return res.json(contacts);
});

contactRoutes.post("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { name, number, email, whatsappId, source, leadStatus, assignedUserId, inactivityMinutes, inactivityWebhookId, tags } = req.body;
  const contact = await CreateContactService({
    companyId,
    name,
    number,
    email,
    whatsappId,
    source,
    leadStatus,
    assignedUserId,
    inactivityMinutes,
    inactivityWebhookId,
    tags
  });
  return res.status(201).json(contact);
});

contactRoutes.put("/:contactId", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { contactId } = req.params;
  const { name, number, email, whatsappId, source, leadStatus, assignedUserId, inactivityMinutes, inactivityWebhookId, tags } = req.body;
  const contact = await UpdateContactService({
    companyId,
    contactId: parseInt(contactId),
    name,
    number,
    email,
    whatsappId,
    source,
    leadStatus,
    assignedUserId,
    inactivityMinutes,
    inactivityWebhookId,
    tags
  });
  return res.json(contact);
});

contactRoutes.post("/:contactId/mark-read", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { contactId } = req.params;
  const contact = await Contact.findOne({ where: { id: parseInt(contactId), companyId } });
  if (!contact) throw new AppError("Contacto no encontrado", 404);
  await contact.update({ leadStatus: "read", lastInteractionAt: new Date() } as any);
  return res.json(contact);
});

contactRoutes.delete("/:contactId", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { contactId } = req.params;
  await DeleteContactService({ companyId, contactId: parseInt(contactId) });
  return res.status(204).send();
});

contactRoutes.post("/:contactId/message", isAuth, async (req: any, res) => {
  const { companyId, id: userId } = req.user;
  const { contactId } = req.params;
  const { body, templateName, languageCode, templateVariables, mediaUrl, mediaType, caption } = req.body;

  const result = await SendMessageToContactService({
    companyId,
    userId,
    contactId: parseInt(contactId),
    body,
    templateName,
    languageCode,
    templateVariables,
    mediaUrl,
    mediaType,
    caption
  });

  return res.status(201).json(result);
});

export default contactRoutes;
