import { WASocket, proto } from "@whiskeysockets/baileys";
import crypto from "crypto";
import { Op, QueryTypes } from "sequelize";

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Whatsapp from "../../models/Whatsapp";
import sequelize from "../../database";
import { getIO } from "../../libs/socket";
import { recordInboundDuplicate, recordInboundError, recordInboundMessage } from "../../utils/messageStats";
import { generateConversationalReply } from "../AIServices/ConversationOrchestrator";
import SendMessageService from "../MessageServices/SendMessageService";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";

interface Session extends WASocket {
  id: number; // whatsappId
}

const autoReplyCooldownMap = new Map<string, number>();

const decisionPreview = (text: string, max = 180) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);

const persistDecisionLog = async (args: {
  companyId: number;
  ticketId: number;
  decisionKey: string;
  reason: string;
  guardrailAction: string;
  responsePreview?: string;
}) => {
  try {
    await sequelize.query(
      `INSERT INTO ai_decision_logs (ticket_id, company_id, conversation_type, decision_key, reason, guardrail_action, response_preview, created_at)
       VALUES (:ticketId, :companyId, 'whatsapp', :decisionKey, :reason, :guardrailAction, :responsePreview, NOW())`,
      {
        replacements: {
          ticketId: args.ticketId,
          companyId: args.companyId,
          decisionKey: args.decisionKey,
          reason: args.reason,
          guardrailAction: args.guardrailAction,
          responsePreview: args.responsePreview || ""
        },
        type: QueryTypes.INSERT
      }
    );
  } catch {
    // non-blocking: table may not exist in older dbs
  }
};

const cooldownKey = (companyId: number, contactId: number) => `${companyId}:${contactId}`;

const shouldSkipByCooldown = (companyId: number, contactId: number) => {
  const settings = getRuntimeSettings();
  const cooldownSec = Math.max(10, Number(settings.waOutboundDedupeTtlSeconds || 120));
  const key = cooldownKey(companyId, contactId);
  const now = Date.now();
  const last = Number(autoReplyCooldownMap.get(key) || 0);
  if (last > 0 && now - last < cooldownSec * 1000) {
    return { skip: true, reason: `cooldown_${cooldownSec}s` };
  }
  autoReplyCooldownMap.set(key, now);
  return { skip: false, reason: "ok" };
};

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

const tryAutoReply = async (args: {
  companyId: number;
  ticket: Ticket;
  contact: Contact;
  fromMe: boolean;
  body: string;
  mediaType: string;
}) => {
  const { companyId, ticket, contact, fromMe, body, mediaType } = args;

  const reason = fromMe
    ? "skip_from_me"
    : String(mediaType || "") !== "chat"
      ? "skip_non_chat"
      : !String(body || "").trim()
        ? "skip_empty"
        : ticket.isGroup
          ? "skip_group"
          : ticket.bot_enabled === false
            ? "skip_bot_disabled"
            : ticket.human_override === true
              ? "skip_human_override"
              : "ok";

  if (reason !== "ok") {
    await persistDecisionLog({
      companyId,
      ticketId: ticket.id,
      decisionKey: "auto_reply_guardrail",
      reason,
      guardrailAction: "skip"
    });
    return;
  }

  const cooldown = shouldSkipByCooldown(companyId, contact.id);
  if (cooldown.skip) {
    await persistDecisionLog({
      companyId,
      ticketId: ticket.id,
      decisionKey: "auto_reply_guardrail",
      reason: cooldown.reason,
      guardrailAction: "skip"
    });
    return;
  }

  const startedAt = Date.now();
  const result = await generateConversationalReply({
    companyId,
    ticketId: ticket.id,
    contactId: contact.id,
    text: body
  });

  const reply = String(result.reply || "").trim();
  if (!reply) {
    await persistDecisionLog({
      companyId,
      ticketId: ticket.id,
      decisionKey: "auto_reply_result",
      reason: "empty_reply",
      guardrailAction: "skip"
    });
    return;
  }

  await SendMessageService({
    ticketId: ticket.id,
    contactId: contact.id,
    body: reply,
    userId: 0
  } as any);

  const latencyMs = Date.now() - startedAt;
  await persistDecisionLog({
    companyId,
    ticketId: ticket.id,
    decisionKey: "auto_reply_sent",
    reason: `ok_latency_${latencyMs}ms`,
    guardrailAction: "allow",
    responsePreview: decisionPreview(reply)
  });
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

  try {
    await tryAutoReply({ companyId: whatsapp.companyId, ticket, contact, fromMe, body, mediaType });
  } catch (error: any) {
    recordInboundError(error);
    console.error(`Error en auto-reply ticket=${ticket.id}:`, error?.message || error);
  }
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
