import Whatsapp from "../../models/Whatsapp";
import Contact from "../../models/Contact";
import Message from "../../models/Message";
import crypto from "crypto";
import AppError from "../../errors/AppError";
import { getWbot } from "../../libs/wbot";
import { getIO } from "../../libs/socket";

interface SendOutboundTextRequest {
  companyId: number;
  whatsappId?: number;
  to: string;
  text: string;
  contactName?: string;
  idempotencyKey?: string;
}

const normalizeNumber = (raw: string): string => (raw || "").replace(/\D/g, "");

const SendOutboundTextService = async ({ companyId, whatsappId, to, text, contactName, idempotencyKey }: SendOutboundTextRequest) => {
  const toNorm = normalizeNumber(to);
  if (!toNorm) throw new AppError("Invalid destination number", 400);
  if (!text?.trim()) throw new AppError("Text is required", 400);

  const wa = whatsappId
    ? await Whatsapp.findOne({ where: { id: whatsappId, companyId } })
    : await Whatsapp.findOne({ where: { companyId, isDefault: true } });

  if (!wa) throw new AppError("No WhatsApp connection available", 400);

  const wbot = getWbot(wa.id);
  if (!wbot) throw new AppError("WhatsApp not connected", 400);

  let contact = await Contact.findOne({ where: { companyId, number: toNorm } });
  if (!contact) {
    contact = await Contact.create({
      companyId,
      name: contactName || toNorm,
      number: toNorm,
      email: "",
      profilePicUrl: "",
      isGroup: false,
      whatsappId: wa.id
    });
  }

  const jid = `${toNorm}@s.whatsapp.net`;
  const sent = await wbot.sendMessage(jid, { text });

  const msg = await Message.create({
    id: sent?.key?.id || crypto.randomUUID(),
    body: text,
    contactId: contact.id,
    ticketId: null,
    fromMe: true,
    read: true,
    mediaType: "chat"
  } as any);

  const io = getIO();
  io.to(`conversation-${contact.id}`).emit("appMessage", { action: "create", message: msg, conversationId: contact.id, contact });

  return { conversationId: contact.id, contact, message: msg, idempotencyKey: idempotencyKey || null };
};

export default SendOutboundTextService;
