/**
 * Process Chatwoot Webhook Service
 *
 * Receives Chatwoot message_created webhooks, processes inbound messages through
 * the AI ConversationOrchestrator, and sends replies back via ChatwootApiClient.
 *
 * This is the Chatwoot channel adapter — analogous to ProcessCloudWebhookService
 * for WhatsApp Cloud, but much simpler since Chatwoot handles the transport layer.
 */

import * as crypto from "crypto";
import { QueryTypes } from "sequelize";
import { generateConversationalReply } from "../AIServices/ConversationOrchestrator";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Whatsapp from "../../models/Whatsapp";
import Tag from "../../models/Tag";
import ContactTag from "../../models/ContactTag";
import sequelize from "../../database";
import { getIO } from "../../libs/socket";
import { sendAIResponse, getChatwootConfig } from "./ChatwootApiClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatwootWebhookPayload {
  event?: string;
  message_type?: string;
  private?: boolean;
  content?: string;
  content_type?: string;
  id?: number;
  conversation?: {
    id?: number;
    contact_inbox?: {
      source_id?: string;
      inbox_id?: number;
    };
    meta?: {
      sender?: {
        id?: number;
        name?: string;
        phone_number?: string;
        blocked?: boolean;
        custom_attributes?: Record<string, any>;
      };
      contact?: {
        custom_attributes?: Record<string, any>;
      };
    };
    status?: string;
  };
  sender?: {
    id?: number;
    name?: string;
    phone_number?: string;
    blocked?: boolean;
  };
  account?: {
    id?: number;
    name?: string;
  };
  inbox?: {
    id?: number;
    name?: string;
  };
  // Support for the body-wrapped format (Chatwoot sends both flat and nested)
  body?: ChatwootWebhookPayload;
}

type ConversationType = "sales" | "support" | "scheduling" | "general";
type Policy = { maxReplyChars?: number; allowAutoClose?: boolean; autoHandoffOnSensitive?: boolean; forbiddenKeywords?: string[] };

const defaultPolicies: Record<ConversationType, Policy> = {
  sales: { maxReplyChars: 800, allowAutoClose: false, autoHandoffOnSensitive: false, forbiddenKeywords: ["descuento extremo", "garantía absoluta"] },
  support: { maxReplyChars: 800, allowAutoClose: false, autoHandoffOnSensitive: true, forbiddenKeywords: ["culpa del cliente"] },
  scheduling: { maxReplyChars: 500, allowAutoClose: true, autoHandoffOnSensitive: false, forbiddenKeywords: [] },
  general: { maxReplyChars: 800, allowAutoClose: true, autoHandoffOnSensitive: false, forbiddenKeywords: [] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bot agent names to ignore (outgoing messages from our own agents) */
const getBotAgentNames = (): string[] => {
  const raw = process.env.CHATWOOT_BOT_AGENT_NAMES || "Marcos Lewis,Charlott";
  return raw.split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
};

const getDefaultCompanyId = (): number => {
  return Number(process.env.CHATWOOT_DEFAULT_COMPANY_ID || process.env.META_DEFAULT_COMPANY_ID || 1);
};

const classifyConversation = (text: string): ConversationType => {
  const t = String(text || "").toLowerCase();
  if (/turno|agenda|cita|horario|fecha|mañana|lunes|martes/.test(t)) return "scheduling";
  if (/error|soporte|no funciona|problema|incidente|ca[ií]do/.test(t)) return "support";
  if (/precio|plan|comprar|contratar|promo|descuento|cotiz|propiedad|departamento|depto|casa|alquiler|venta|inmueble|ambientes?|monoambiente|ph\b|terreno|lote|zonas?/.test(t)) return "sales";
  return "general";
};

const isLowSignalMessage = (text: string): boolean => {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (/^[👍👌👏🙏😂🤣❤❤️😀😊🎉✅🙌💪\s]+$/.test(t)) return true;
  return /^(ok|oka|dale|genial|gracias|joya|perfecto|👍|👌|🙏)$/.test(t);
};

const applyGuardrails = ({ text, reply, conversationType }: { text: string; reply: string; conversationType: ConversationType }): { finalReply?: string; handoff?: boolean; reason: string; action: string } => {
  const policy = defaultPolicies[conversationType] || defaultPolicies.general;
  const low = text.toLowerCase();
  if (policy.autoHandoffOnSensitive && /legal|abogado|demanda|tarjeta|transferencia|cbu/.test(low)) {
    return { handoff: true, reason: "Tema sensible detectado", action: "handoff_sensitive" };
  }
  const forbidden = (policy.forbiddenKeywords || []).find((k) => k && reply.toLowerCase().includes(k.toLowerCase()));
  let safeReply = forbidden ? "Gracias por tu consulta. Te derivo con un asesor humano para darte una respuesta precisa." : reply;
  const max = Number(policy.maxReplyChars || 800);
  if (safeReply.length > max) safeReply = `${safeReply.slice(0, Math.max(60, max - 1))}…`;
  return { finalReply: safeReply, handoff: Boolean(forbidden), reason: forbidden ? `Keyword prohibido: ${forbidden}` : "ok", action: forbidden ? "handoff_forbidden_keyword" : "pass" };
};

const logDecision = async (params: { companyId: number; ticketId: number; conversationType: string; decisionKey: string; reason: string; guardrailAction: string; responsePreview: string }) => {
  try {
    await sequelize.query(
      `INSERT INTO ai_decision_logs (company_id, ticket_id, conversation_type, decision_key, guardrail_action, response_preview, created_at, updated_at)
       VALUES (:companyId, :ticketId, :conversationType, :decisionKey, :guardrailAction, :responsePreview, NOW(), NOW())`,
      {
        replacements: {
          companyId: params.companyId,
          ticketId: params.ticketId,
          conversationType: params.conversationType,
          decisionKey: params.decisionKey,
          guardrailAction: params.guardrailAction,
          responsePreview: String(params.responsePreview || "").slice(0, 240),
        },
        type: QueryTypes.INSERT,
      }
    );
  } catch {}
};

const emitToCompany = (companyId: number, event: string, data: any) => {
  try {
    const io = getIO();
    io.to(`company-${companyId}`).emit(event, data);
  } catch {}
};

const ensureArchivedTag = async (contactId: number) => {
  const [tag] = await Tag.findOrCreate({ where: { name: "archivado" }, defaults: { name: "archivado", color: "#6b7280" } as any });
  const exists = await ContactTag.findOne({ where: { contactId, tagId: tag.id } });
  if (!exists) await ContactTag.create({ contactId, tagId: tag.id } as any);
};

// ---------------------------------------------------------------------------
// Inbound replay guard (simple in-memory dedup for Chatwoot webhook retries)
// ---------------------------------------------------------------------------

const recentMessageIds = new Map<string, number>();
const REPLAY_TTL_MS = 60 * 60 * 1000; // 1h

const isReplay = (messageId: string | number): boolean => {
  const key = String(messageId);
  const now = Date.now();

  // Prune old entries periodically
  if (recentMessageIds.size > 5000) {
    recentMessageIds.forEach((ts, k) => {
      if (now - ts > REPLAY_TTL_MS) recentMessageIds.delete(k);
    });
  }

  if (recentMessageIds.has(key)) return true;
  recentMessageIds.set(key, now);
  return false;
};

// ---------------------------------------------------------------------------
// Core: resolve or create Whatsapp channel record for Chatwoot
// ---------------------------------------------------------------------------

let cachedChatwootWhatsapp: any = null;

const resolveChatwootWhatsapp = async (): Promise<any> => {
  if (cachedChatwootWhatsapp) return cachedChatwootWhatsapp;

  const companyId = getDefaultCompanyId();
  let wa = await Whatsapp.findOne({ where: { name: "chatwoot", companyId } } as any);

  if (!wa) {
    wa = await Whatsapp.create({
      name: "chatwoot",
      status: "CONNECTED",
      companyId,
      isDefault: false,
      greetingMessage: "",
      farewellMessage: "",
    } as any);
    console.log("[chatwoot] created Whatsapp channel record:", wa.id);
  }

  cachedChatwootWhatsapp = wa;
  return wa;
};

// ---------------------------------------------------------------------------
// Core: Process inbound Chatwoot webhook
// ---------------------------------------------------------------------------

export const processChatwootWebhook = async (payload: ChatwootWebhookPayload): Promise<{ processed: boolean; reason: string }> => {
  const cfg = getChatwootConfig();
  if (!cfg) {
    console.warn("[chatwoot] webhook received but CHATWOOT config not set");
    return { processed: false, reason: "missing_config" };
  }

  // Normalize: Chatwoot may wrap the payload in a "body" key depending on n8n/direct config
  const msg = payload.body || payload;

  // --- Filter: only message_created events ---
  if (msg.event !== "message_created" && payload.event !== "message_created") {
    // Also accept payloads that have message_type=incoming directly (from Chatwoot webhook format)
    if (msg.message_type !== "incoming") {
      return { processed: false, reason: "not_message_created" };
    }
  }

  // --- Filter: only incoming, not private ---
  if (msg.message_type !== "incoming") return { processed: false, reason: "not_incoming" };
  if (msg.private === true || String(msg.private) === "true") return { processed: false, reason: "private_message" };

  // --- Filter: ignore messages from bot agent names ---
  const senderName = String(msg.sender?.name || "").trim();
  const botNames = getBotAgentNames();
  if (botNames.some((bn) => senderName.toLowerCase() === bn)) {
    return { processed: false, reason: "bot_agent_message" };
  }

  // --- Extract data ---
  const conversationId = msg.conversation?.id;
  const content = String(msg.content || "").trim();
  const contentType = String(msg.content_type || msg.content_type || "text");
  const chatwootMessageId = msg.id;
  const senderId = msg.sender?.id || msg.conversation?.meta?.sender?.id;
  const senderPhone = msg.sender?.phone_number || "";
  const sourceId = msg.conversation?.contact_inbox?.source_id || "";

  // Use source_id (external channel ID like WhatsApp number) or sender ID as contact identifier
  const contactIdentifier = sourceId || String(senderId || "");

  if (!conversationId || !content || !contactIdentifier) {
    return { processed: false, reason: "missing_required_fields" };
  }

  // Only handle text messages for now
  if (contentType !== "text") {
    return { processed: false, reason: `unsupported_content_type_${contentType}` };
  }

  // --- Replay guard ---
  if (chatwootMessageId && isReplay(chatwootMessageId)) {
    return { processed: false, reason: "replay_blocked" };
  }

  // --- Check blocked + chatbot status from Chatwoot custom attributes ---
  const senderBlocked = msg.sender?.blocked === true;
  const customAttrs = msg.conversation?.meta?.sender?.custom_attributes ||
                      msg.conversation?.meta?.contact?.custom_attributes || {};
  const chatbotStatus = String(customAttrs.chatbot || "").toUpperCase();

  if (senderBlocked) return { processed: false, reason: "contact_blocked" };
  if (chatbotStatus === "OFF") return { processed: false, reason: "chatbot_off" };

  // --- Resolve company + WhatsApp channel ---
  const companyId = getDefaultCompanyId();
  const whatsapp = await resolveChatwootWhatsapp();

  // --- Get or create Contact ---
  const normalizedNumber = contactIdentifier.replace(/\D/g, "") || contactIdentifier;
  let contact = await Contact.findOne({ where: { number: normalizedNumber, companyId } } as any);
  if (!contact) {
    contact = await Contact.create({
      name: senderName || `Chatwoot ${normalizedNumber}`,
      number: normalizedNumber,
      companyId,
      isGroup: false,
      leadStatus: "unread",
    } as any);
    console.log("[chatwoot] created contact:", contact.id, normalizedNumber);
  } else if (senderName && (contact as any).name !== senderName) {
    await (contact as any).update({ name: senderName });
  }

  // --- Get or create Ticket ---
  // Use chatwoot conversation ID in a stable way. We look for open tickets for this contact.
  let ticket = await Ticket.findOne({
    where: {
      contactId: contact.id,
      companyId,
      status: { [require("sequelize").Op.ne]: "closed" },
    },
    order: [["updatedAt", "DESC"]],
  } as any);

  if (!ticket) {
    ticket = await Ticket.create({
      contactId: contact.id,
      whatsappId: whatsapp.id,
      companyId,
      status: "pending",
      unreadMessages: 1,
      lastMessage: content.slice(0, 255),
      bot_enabled: true,
      human_override: false,
    } as any);
    console.log("[chatwoot] created ticket:", ticket.id, "for contact:", contact.id);
  } else {
    await (ticket as any).update({
      unreadMessages: ((ticket as any).unreadMessages || 0) + 1,
      lastMessage: content.slice(0, 255),
      updatedAt: new Date(),
    });
  }

  // --- Create Message record ---
  const messageId = chatwootMessageId ? `cw-${chatwootMessageId}` : `cw-${crypto.randomUUID()}`;
  const message = await Message.create({
    id: messageId,
    body: content,
    contactId: contact.id,
    ticketId: ticket.id,
    fromMe: false,
    read: false,
    ack: 0,
    mediaType: "chat",
  } as any);

  // --- Emit to dashboard ---
  emitToCompany(companyId, "newMessage", { action: "create", message, ticket, contact });
  emitToCompany(companyId, "ticketUpdate", { action: "update", ticket });

  // --- Run AI Agent ---
  await runChatwootAgent({ ticket, contact, incomingText: content, conversationId });

  return { processed: true, reason: "ok" };
};

// ---------------------------------------------------------------------------
// AI Agent runner (Chatwoot-specific send logic, reuses ConversationOrchestrator)
// ---------------------------------------------------------------------------

const runChatwootAgent = async ({
  ticket,
  contact,
  incomingText,
  conversationId,
}: {
  ticket: any;
  contact: any;
  incomingText: string;
  conversationId: number;
}) => {
  const text = String(incomingText || "").trim();
  if (!text || (ticket as any).human_override || (ticket as any).bot_enabled === false) return;

  const low = text.toLowerCase();
  const conversationType = classifyConversation(text);

  // Log inbound turn
  try {
    await sequelize.query(
      `INSERT INTO ai_turns (conversation_id, role, content, model, latency_ms, tokens_in, tokens_out, created_at, updated_at)
       VALUES (NULL, 'user', :content, 'chatwoot', 0, 0, 0, NOW(), NOW())`,
      { replacements: { content: text }, type: QueryTypes.INSERT }
    );
  } catch {}

  // --- Human handoff request ---
  if (/humano|asesor|agente|persona/.test(low)) {
    await (ticket as any).update({ human_override: true, bot_enabled: false, updatedAt: new Date() });
    const transferText = "Perfecto. Te paso con un asesor humano para continuar 🙌";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "manual_handoff", reason: "Cliente pidió humano", guardrailAction: "handoff", responsePreview: transferText });
    await sendAndRecord({ ticket, contact, text: transferText, conversationId });
    return;
  }

  // --- Auto-close on conclusive messages ---
  const isStandaloneConclusion = /^(gracias[.!]?|muchas gracias[.!]?|resuelto[.!]?|buenísimo[.!]?)$/i.test(low.trim());
  const isShortConclusion = low.trim().length <= 40 && /^(gracias|perfecto|listo|resuelto)[\s.,!]/.test(low.trim());
  if ((isStandaloneConclusion || isShortConclusion) && defaultPolicies[conversationType]?.allowAutoClose) {
    const closeText = "¡Excelente! Cierro esta conversación por ahora ✅ Si necesitás algo más, escribime y la retomamos enseguida.";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "auto_close", reason: "Cierre positivo detectado", guardrailAction: "close", responsePreview: closeText });
    await sendAndRecord({ ticket, contact, text: closeText, conversationId });
    await (ticket as any).update({ status: "closed", unreadMessages: 0, lastMessage: closeText, updatedAt: new Date() });
    await ensureArchivedTag(contact.id);
    await (contact as any).update({ leadStatus: "read", lastInteractionAt: new Date() });
    return;
  }

  // --- Low signal: silence ---
  if (isLowSignalMessage(low)) {
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "no_reply_low_signal", reason: "Mensaje de baja señal", guardrailAction: "silence", responsePreview: "" });
    return;
  }

  // --- Call ConversationOrchestrator ---
  let baseReply = "";
  try {
    const orchResult = await generateConversationalReply({
      companyId: ticket.companyId,
      text,
      contactId: contact.id,
      ticketId: ticket.id,
    });

    if (orchResult.usedFallback) {
      console.error("[chatwoot][agent] orchestrator fallback, escalating to human", { ticketId: ticket.id });
      await (ticket as any).update({ human_override: true, bot_enabled: false, updatedAt: new Date() });
      const errText = "Tuve un inconveniente técnico. Te paso con un asesor para que te atienda enseguida 🙏";
      await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "ai_failure_handoff", reason: "Fallo de IA: escalado a humano", guardrailAction: "handoff", responsePreview: errText });
      await sendAndRecord({ ticket, contact, text: errText, conversationId });
      return;
    }

    baseReply = String(orchResult.reply || "").trim();
  } catch (orchErr: any) {
    console.error("[chatwoot][agent] orchestrator error:", orchErr?.message || orchErr);
    await (ticket as any).update({ human_override: true, bot_enabled: false, updatedAt: new Date() });
    const errText = "Tuve un inconveniente técnico. Te paso con un asesor para que te atienda enseguida 🙏";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "ai_failure_handoff", reason: `Excepción: ${orchErr?.message || "unknown"}`, guardrailAction: "handoff", responsePreview: errText });
    await sendAndRecord({ ticket, contact, text: errText, conversationId });
    return;
  }

  if (!baseReply) {
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "no_reply_orchestrator_empty", reason: "Orquestador sin respuesta", guardrailAction: "silence", responsePreview: "" });
    return;
  }

  // --- Apply guardrails ---
  const guardrail = applyGuardrails({ text, reply: baseReply, conversationType });
  if (guardrail.handoff) {
    await (ticket as any).update({ human_override: true, bot_enabled: false, updatedAt: new Date() });
    const txt = "Gracias por tu mensaje. Te paso con un asesor humano para tratar este tema con prioridad.";
    await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "guardrail_handoff", reason: guardrail.reason, guardrailAction: guardrail.action, responsePreview: txt });
    await sendAndRecord({ ticket, contact, text: txt, conversationId });
    return;
  }

  const reply = guardrail.finalReply || baseReply;
  await logDecision({ companyId: ticket.companyId, ticketId: ticket.id, conversationType, decisionKey: "reply", reason: guardrail.reason, guardrailAction: guardrail.action, responsePreview: reply.slice(0, 240) });

  // Send via Chatwoot (multi-part with photos if property listing detected)
  const sendResult = await sendAIResponse(conversationId, reply);
  if (sendResult.sent > 0) {
    // Record the full reply as a single outbound message in our DB
    const outId = `cw-out-${crypto.randomUUID()}`;
    const outMsg = await Message.create({
      id: outId,
      body: reply,
      contactId: contact.id,
      ticketId: ticket.id,
      fromMe: true,
      read: true,
      ack: 1,
      mediaType: "chat",
    } as any);

    emitToCompany(ticket.companyId, "newMessage", { action: "create", message: outMsg, ticket, contact });
    await (ticket as any).update({
      status: (ticket as any).status === "pending" ? "open" : (ticket as any).status,
      lastMessage: reply.slice(0, 255),
      updatedAt: new Date(),
    });

    // Auto summary + lead scoring
    await autoSummaryAndScore(ticket.id, contact);
  }
};

// ---------------------------------------------------------------------------
// Helper: send text + record in DB (for handoff/close single messages)
// ---------------------------------------------------------------------------

const sendAndRecord = async ({
  ticket,
  contact,
  text,
  conversationId,
}: {
  ticket: any;
  contact: any;
  text: string;
  conversationId: number;
}) => {
  const cfg = getChatwootConfig();
  const { sendChatwootTextMessage } = require("./ChatwootApiClient");
  const result = await sendChatwootTextMessage(conversationId, text, cfg);
  if (!result.ok) {
    console.error("[chatwoot][sendAndRecord] failed:", result.error);
    return;
  }

  const outId = `cw-out-${crypto.randomUUID()}`;
  await Message.create({
    id: outId,
    body: text,
    contactId: contact.id,
    ticketId: ticket.id,
    fromMe: true,
    read: true,
    ack: 1,
    mediaType: "chat",
  } as any);

  await (ticket as any).update({ lastMessage: text, updatedAt: new Date() });
};

// ---------------------------------------------------------------------------
// Auto summary + lead score (reused from WhatsApp Cloud flow)
// ---------------------------------------------------------------------------

const autoSummaryAndScore = async (ticketId: number, contact: any) => {
  try {
    const inbound = await Message.findAll({ where: { ticketId, fromMe: false }, order: [["createdAt", "DESC"]], limit: 6 } as any);
    const joined = inbound.map((m: any) => String(m.body || "").trim()).filter(Boolean).reverse().join(" | ");
    if (!joined) return;
    let score = Number(contact.lead_score || 0);
    if (/comprar|contratar|precio|plan|quiero|usd|d[oó]lar|departamento|casa/i.test(joined)) score = Math.max(score, 65);
    if (/urgente|ahora|hoy|visita|seña/i.test(joined)) score = Math.max(score, 75);
    if (/gracias|resuelto|listo/i.test(joined)) score = Math.max(score, 40);
    await contact.update({ needs: joined.slice(0, 900), lead_score: Math.min(100, score), updatedAt: new Date() });
  } catch {}
};
