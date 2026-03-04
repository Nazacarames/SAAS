import { getWbot } from "../../libs/wbot";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import AppError from "../../errors/AppError";
import { getIO } from "../../libs/socket";
import crypto from "crypto";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";
import sequelize from "../../database";
import { Op, QueryTypes } from "sequelize";

interface SendMessageRequest {
  body?: string;
  contactId?: number;
  ticketId?: number;
  userId: number;
  templateName?: string;
  languageCode?: string;
  templateVariables?: string[];
  mediaUrl?: string;
  mediaType?: "image" | "video" | "audio" | "document";
  caption?: string;
  idempotencyKey?: string;
}

const mapMetaError = (data: any, fallback = "Error al enviar mensaje") => {
  const code = Number(data?.error?.code || 0);
  const msg = String(data?.error?.message || fallback);

  if (code === 131031) return new AppError("Meta bloqueó/restringió la cuenta de WhatsApp (131031)", 409);
  if (code === 190) return new AppError("Token de Meta vencido o inválido (190). Reconectá OAuth.", 401);
  if (code === 100) return new AppError("Configuración inválida de Phone Number ID o permisos (100)", 400);

  return new AppError(msg, 500);
};

const resolveCloudCredentials = async (companyId?: number) => {
  const runtime = getRuntimeSettings();

  const [conn]: any = await sequelize.query(
    `SELECT phone_number_id, access_token
     FROM meta_connections
     ${companyId ? "WHERE company_id = :companyId" : ""}
     ORDER BY id DESC LIMIT 1`,
    {
      replacements: companyId ? { companyId } : {},
      type: QueryTypes.SELECT
    }
  );

  const phoneNumberId = String(conn?.phone_number_id || runtime.waCloudPhoneNumberId || "").trim();
  const accessToken = String(conn?.access_token || runtime.waCloudAccessToken || "").trim();

  return { phoneNumberId, accessToken };
};

const sendViaCloudTemplate = async (
  companyId: number | undefined,
  toRaw: string,
  templateName: string,
  languageCode = "es_AR",
  bodyParams: string[] = [],
  idempotencyKey?: string
): Promise<string> => {
  const to = String(toRaw || "").replace(/\D/g, "");
  const { phoneNumberId, accessToken } = await resolveCloudCredentials(companyId);

  if (!to || !phoneNumberId || !accessToken) {
    throw new AppError("WhatsApp Cloud no conectado", 404);
  }

  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((v) => ({ type: "text", text: String(v || "") })) }]
    : undefined;

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {})
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {})
      }
    })
  });

  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw mapMetaError(data, "Error al enviar template");
  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const sendViaCloudText = async (companyId: number | undefined, toRaw: string, text: string, idempotencyKey?: string): Promise<string> => {
  const to = String(toRaw || "").replace(/\D/g, "");
  const { phoneNumberId, accessToken } = await resolveCloudCredentials(companyId);

  if (!to || !phoneNumberId || !accessToken) {
    throw new AppError("WhatsApp Cloud no conectado", 404);
  }

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {})
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });

  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw mapMetaError(data);

  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const sendViaCloudMedia = async (
  companyId: number | undefined,
  toRaw: string,
  mediaUrl: string,
  mediaType: "image" | "video" | "audio" | "document" = "image",
  caption = "",
  idempotencyKey?: string
): Promise<string> => {
  const to = String(toRaw || "").replace(/\D/g, "");
  const { phoneNumberId, accessToken } = await resolveCloudCredentials(companyId);

  if (!to || !phoneNumberId || !accessToken) {
    throw new AppError("WhatsApp Cloud no conectado", 404);
  }

  const payload: any = {
    messaging_product: "whatsapp",
    to,
    type: mediaType,
    [mediaType]: {
      link: String(mediaUrl || "").trim()
    }
  };

  if (caption && mediaType !== "audio") payload[mediaType].caption = caption;

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {})
    },
    body: JSON.stringify(payload)
  });

  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw mapMetaError(data, "Error al enviar media");

  return data?.messages?.[0]?.id || `meta-${Date.now()}`;
};

const SendMessageService = async ({ body, ticketId, contactId, templateName, languageCode, templateVariables, mediaUrl, mediaType, caption, idempotencyKey }: SendMessageRequest): Promise<Message> => {
  let ticket: any = null;
  if (ticketId) ticket = await Ticket.findByPk(ticketId, {
    include: [
      { model: Contact, as: "contact" },
      { model: require("../../models/Whatsapp").default, as: "whatsapp" }
    ]
  });

  if (!ticket && contactId) {
    ticket = await Ticket.findOne({
      where: { contactId, status: { [Op.in]: ["open", "pending"] } },
      order: [["updatedAt", "DESC"]],
      include: [
        { model: Contact, as: "contact" },
        { model: require("../../models/Whatsapp").default, as: "whatsapp" }
      ]
    } as any);
  }

  if (!ticket) {
    throw new AppError("Conversación no encontrada", 404);
  }

  const isTemplate = Boolean(String(templateName || "").trim());
  const isMedia = Boolean(String(mediaUrl || "").trim());
  const cleanBody = String(body || "").trim();

  if (!isTemplate && !isMedia && !cleanBody) {
    throw new AppError("Mensaje vacío", 400);
  }

  try {
    let msgId: any = crypto.randomUUID();
    const wbot = getWbot((ticket as any).whatsappId);

    try {
      if (isTemplate) {
        const firstName = String((ticket as any)?.contact?.name || "cliente").split(/\s+/)[0] || "cliente";
        const vars = Array.isArray(templateVariables) && templateVariables.length
          ? templateVariables
          : [/hola/i.test(String(templateName || "")) ? firstName : ""].filter(Boolean);
        msgId = await sendViaCloudTemplate((ticket as any).companyId, (ticket as any).contact.number, String(templateName).trim(), String(languageCode || "es_AR"), vars, idempotencyKey);
      } else if (isMedia) {
        msgId = await sendViaCloudMedia(
          (ticket as any).companyId,
          (ticket as any).contact.number,
          String(mediaUrl || "").trim(),
          (mediaType || "image") as any,
          String(caption || "").trim(),
          idempotencyKey
        );
      } else {
        msgId = await sendViaCloudText((ticket as any).companyId, (ticket as any).contact.number, cleanBody, idempotencyKey);
      }
    } catch (cloudErr: any) {
      if (!wbot) throw cloudErr;
      if (isTemplate || isMedia) throw cloudErr;
      const contactNumber = `${(ticket as any).contact.number}@s.whatsapp.net`;
      const sentMessage: any = await wbot.sendMessage(contactNumber, { text: cleanBody });
      msgId = sentMessage?.key?.id || msgId;
    }

    const persistedBody = isTemplate
      ? `[TEMPLATE:${String(templateName || "").trim()}]`
      : isMedia
        ? `${caption ? `${caption}\n` : ""}${String(mediaUrl || "").trim()}`.trim()
        : cleanBody;

    const message = await Message.create({
      id: msgId,
      body: persistedBody,
      contactId: (ticket as any).contactId,
      ticketId: (ticket as any)?.id || null,
      fromMe: true,
      read: true,
      ack: 0,
      mediaType: isTemplate ? "template" : (isMedia ? String(mediaType || "image") : "chat")
    } as any);

    await (ticket as any).update({ lastMessage: persistedBody, updatedAt: new Date() });

    const io = getIO();
    io.to(`ticket-${(ticket as any).id}`).emit("appMessage", {
      action: "create",
      message,
      ticket,
      contact: (ticket as any).contact
    });

    return message;
  } catch (error: any) {
    console.error("Error al enviar mensaje:", error?.message || error);
    throw error instanceof AppError ? error : new AppError("Error al enviar mensaje", 500);
  }
};

export default SendMessageService;
