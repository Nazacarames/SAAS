import { Router } from "express";
import isAuth from "../middleware/isAuth";
import SendMessageService from "../services/MessageServices/SendMessageService";
import ListMessagesService from "../services/MessageServices/ListMessagesService";
import { getRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";

const messageRoutes = Router();

// List messages for a conversation (contact-based)
messageRoutes.get("/:conversationId", isAuth, async (req: any, res) => {
  const { conversationId } = req.params;
  const contactId = parseInt(conversationId);
  const messages: any[] = await (ListMessagesService as any)({ contactId });
  return res.json(messages);
});

// Send message to conversation contact via WhatsApp
messageRoutes.post("/", isAuth, async (req: any, res) => {
  const { body, conversationId, contactId, idempotencyKey } = req.body;
  const idempotencyFromHeader = String(req.headers?.["x-idempotency-key"] || "").trim();
  const effectiveIdempotencyKey = String(idempotencyFromHeader || idempotencyKey || "").trim();
  const { id: userId } = req.user;

  const settings = getRuntimeSettings();
  const retryRequiresIdempotency = Boolean(settings?.waOutboundRetryRequireIdempotencyKey);
  if (retryRequiresIdempotency && !effectiveIdempotencyKey) {
    return res.status(400).json({ error: "x-idempotency-key (or body.idempotencyKey) is required" });
  }

  const message = await SendMessageService({
    body,
    contactId: Number(contactId || conversationId),
    userId,
    idempotencyKey: effectiveIdempotencyKey || undefined
  });

  return res.status(201).json(message);
});

export default messageRoutes;
