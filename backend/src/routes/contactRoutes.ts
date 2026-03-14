import { Router } from "express";
import { randomUUID } from "crypto";
import isAuth from "../middleware/isAuth";
import ListContactsService from "../services/ContactServices/ListContactsService";
import CreateContactService from "../services/ContactServices/CreateContactService";
import UpdateContactService from "../services/ContactServices/UpdateContactService";
import DeleteContactService from "../services/ContactServices/DeleteContactService";
import SendMessageToContactService from "../services/ContactServices/SendMessageToContactService";
import Contact from "../models/Contact";
import AppError from "../errors/AppError";
import validateSchema from "../middleware/validateSchema";
import { createContactSchema, updateContactSchema } from "../schemas/contactSchemas";

const contactRoutes = Router();

contactRoutes.get("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { status, assignedUserId, page, limit } = req.query as any;
  const result = await ListContactsService({
    companyId,
    status,
    assignedUserId: assignedUserId === undefined ? undefined : (assignedUserId === "null" ? null : Number(assignedUserId)),
    page: page ? parseInt(page) : undefined,
    limit: limit ? parseInt(limit) : undefined
  });

  // Backward compatibility: legacy frontends expect an array payload.
  // If pagination params are not explicitly requested, return only rows.
  const explicitPagination = page !== undefined || limit !== undefined;
  if (!explicitPagination) {
    return res.json(result.data || []);
  }

  return res.json(result);
});

contactRoutes.post("/", isAuth, validateSchema(createContactSchema), async (req: any, res) => {
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

contactRoutes.put("/:contactId", isAuth, validateSchema(updateContactSchema), async (req: any, res) => {
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
  const { body, templateName, languageCode, templateVariables, mediaUrl, mediaType, caption, idempotencyKey } = req.body;

  const headerIdempotency = String(req.headers?.["x-idempotency-key"] || req.headers?.["idempotency-key"] || "").trim();
  const bodyIdempotency = String(idempotencyKey || "").trim();
  const effectiveIdempotencyKey = bodyIdempotency || headerIdempotency || `ui:${randomUUID()}`;

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
    caption,
    idempotencyKey: effectiveIdempotencyKey
  });

  return res.status(201).json(result);
});

export default contactRoutes;
