import { WASocket, proto } from "@whiskeysockets/baileys";
import crypto from "crypto";
import { Op } from "sequelize";

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Whatsapp from "../../models/Whatsapp";
import { getIO } from "../../libs/socket";
import { recordInboundDuplicate, recordInboundError, recordInboundMessage } from "../../utils/messageStats";

interface Session extends WASocket {
  id: number; // whatsappId
}

const getContactFromMessage = async (msg: proto.IWebMessageInfo, companyId: number) => {
  const remoteJid = msg.key?.remoteJid || "";
  const contactNumber = remoteJid.replace(/\D/g, "");
  if (!contactNumber) return null;

  let contact = await Contact.findOne({ where: { number: contactNumber, companyId } });

  if (!contact) {
    const name = msg.pushName || contactNumber;
    contact = await Contact.create({
      name,
      number: contactNumber,
      companyId,
      isGroup: remoteJid.endsWith("@g.us")
    });
  }

  return contact;
};

const getOrCreateTicket = async (contact: Contact, whatsappId: number, companyId: number) => {
  let ticket = await Ticket.findOne({
    where: {
      contactId: contact.id,
      whatsappId,
      status: { [Op.ne]: "closed" }
    }
  });

  if (!ticket) {
    ticket = await Ticket.create({
      contactId: contact.id,
      whatsappId,
      companyId,
      status: "pending",
      unreadMessages: 1,
      lastMessage: ""
    } as any);
  }

  return ticket;
};

const extractBodyAndType = (msg: proto.IWebMessageInfo) => {
  const m = msg.message;
  if (!m) return { body: "", mediaType: "chat" };

  const body =
    (m.conversation as string) ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    (m.buttonsResponseMessage as any)?.selectedDisplayText ||
    (m.listResponseMessage as any)?.title ||
    "";

  let mediaType = "chat";
  if (m.imageMessage) mediaType = "image";
  else if (m.videoMessage) mediaType = "video";
  else if (m.audioMessage) mediaType = "audio";
  else if (m.documentMessage) mediaType = "document";

  return { body, mediaType };
};

const handleIncomingMessage = async (msg: proto.IWebMessageInfo, wbot: Session) => {
  if (!msg.message) return;
  const fromMe = Boolean(msg.key?.fromMe);

  const whatsapp = await Whatsapp.findByPk(wbot.id);
  if (!whatsapp) return;

  const contact = await getContactFromMessage(msg, whatsapp.companyId);
  if (!contact) return;

  const ticket = await getOrCreateTicket(contact, whatsapp.id, whatsapp.companyId);
  const { body, mediaType } = extractBodyAndType(msg);

  const msgId = msg.key?.id || crypto.randomUUID();
  const createdAt = new Date((Number(msg.messageTimestamp || 0) || Math.floor(Date.now() / 1000)) * 1000);

  // Avoid duplicates if Baileys replays events
  const exists = await Message.findByPk(msgId);
  if (exists) {
    recordInboundDuplicate();
    return;
  }

  const message = await Message.create({
    id: msgId,
    body,
    contactId: contact.id,
    ticketId: ticket.id,
    fromMe,
    read: fromMe,
    ack: 0,
    mediaType,
    createdAt,
    updatedAt: createdAt
  } as any);

  await ticket.update({
    lastMessage: body,
    unreadMessages: fromMe ? (ticket.unreadMessages || 0) : (ticket.unreadMessages || 0) + 1,
    updatedAt: new Date()
  } as any);

  recordInboundMessage({ fromMe, createdAt });
  console.log(`[inbound] msgId=${msgId} ticketId=${ticket.id} fromMe=${fromMe} mediaType=${mediaType}`);

  const io = getIO();
  io.to(`ticket-${ticket.id}`).emit("appMessage", {
    action: "create",
    message,
    ticket,
    contact
  });

  io.to("notification").emit("notification", {
    type: "new-message",
    ticketId: ticket.id,
    contactName: contact.name
  });
};

export const wbotMessageListener = (wbot: Session) => {
  wbot.ev.on("messages.upsert", async (messageUpsert) => {
    const messages = messageUpsert.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      try {
        await handleIncomingMessage(msg, wbot);
      } catch (error) {
        recordInboundError(error);
        console.error("Error al procesar mensaje inbound:", error);
      }
    }
  });

  // Optional: delivery/read updates
  wbot.ev.on("messages.update", async (messageUpdate) => {
    for (const update of messageUpdate) {
      const id = update.key?.id;
      if (!id) continue;

      // status 3 = read in some contexts
      const status = (update.update as any)?.status;
      if (typeof status !== "number") continue;

      try {
        const message = await Message.findByPk(id);
        if (!message) continue;
        await message.update({ ack: status } as any);

        const io = getIO();
        io.to(`ticket-${message.ticketId}`).emit("appMessage", { action: "update", message });
      } catch (error) {
        console.error("Error al actualizar estado de mensaje:", error);
      }
    }
  });
};
