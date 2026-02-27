import { Router } from "express";
import isAuth from "../middleware/isAuth";
import SendMessageService from "../services/MessageServices/SendMessageService";
import ListMessagesService from "../services/MessageServices/ListMessagesService";

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
  const { body, conversationId, contactId } = req.body;
  const { id: userId } = req.user;

  const message = await SendMessageService({
    body,
    contactId: Number(contactId || conversationId),
    userId
  });

  return res.status(201).json(message);
});

export default messageRoutes;
