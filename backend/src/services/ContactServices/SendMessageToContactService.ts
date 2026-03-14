import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Whatsapp from "../../models/Whatsapp";
import SendMessageService from "../MessageServices/SendMessageService";

interface Request {
  companyId: number;
  userId: number;
  contactId: number;
  body?: string;
  templateName?: string;
  languageCode?: string;
  templateVariables?: string[];
  mediaUrl?: string;
  mediaType?: "image" | "video" | "audio" | "document";
  caption?: string;
  idempotencyKey?: string;
}

const SendMessageToContactService = async ({ companyId, userId, contactId, body, templateName, languageCode, templateVariables, mediaUrl, mediaType, caption, idempotencyKey }: Request) => {
  const contact = await Contact.findOne({ where: { id: contactId, companyId } });
  if (!contact) {
    const err: any = new Error("Contact not found");
    err.statusCode = 404;
    throw err;
  }

  let ticket = await Ticket.findOne({
    where: { companyId, contactId, status: ["pending", "open"] as any },
    order: [["updatedAt", "DESC"]]
  });

  if (!ticket) {
    let whatsappId: number | null = (contact as any).whatsappId || null;

    if (!whatsappId) {
      const def = await Whatsapp.findOne({ where: { companyId, isDefault: true } });
      if (def) whatsappId = def.id;
    }

    if (!whatsappId) {
      const anyWa = await Whatsapp.findOne({ where: { companyId }, order: [["id", "ASC"]] });
      if (anyWa) whatsappId = anyWa.id;
    }

    if (!whatsappId) {
      const err: any = new Error("No WhatsApp connection configured");
      err.statusCode = 400;
      throw err;
    }

    ticket = await Ticket.create({
      companyId,
      contactId,
      whatsappId,
      status: "pending",
      unreadMessages: 0,
      isGroup: false,
      lastMessage: String(body || templateName || mediaUrl || "")
    } as any);
  }

  const message = await SendMessageService({
    body,
    ticketId: ticket.id,
    userId,
    templateName,
    languageCode,
    templateVariables,
    mediaUrl,
    mediaType,
    caption,
    idempotencyKey
  });

  try {
    await (contact as any).update({
      leadStatus: "waiting",
      lastInteractionAt: new Date()
    });
  } catch (err: any) {
    console.error(`[SendMessageToContact] contact status update failed for ${contactId}:`, err?.message || err);
  }

  return { ticket, contact, message };
};

export default SendMessageToContactService;
