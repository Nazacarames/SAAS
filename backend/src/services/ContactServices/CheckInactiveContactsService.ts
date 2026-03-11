import crypto from "crypto";
import { Op, QueryTypes } from "sequelize";

import Contact from "../../models/Contact";
import Webhook from "../../models/Webhook";
import Ticket from "../../models/Ticket";
import Whatsapp from "../../models/Whatsapp";
import Message from "../../models/Message";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";
import { getIO } from "../../libs/socket";
import sequelize from "../../database";
import { assertSafeWebhookUrl } from "../../utils/networkSafety";

const safeJson = async (res: any) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

const resolveCloudCredentials = async (companyId?: number) => {
  const runtime = getRuntimeSettings();
  const [conn]: any = await sequelize.query(
    `SELECT phone_number_id, access_token FROM meta_connections ${companyId ? "WHERE company_id = :companyId" : ""} ORDER BY id DESC LIMIT 1`,
    { replacements: companyId ? { companyId } : {}, type: QueryTypes.SELECT }
  );
  return {
    phoneNumberId: String(conn?.phone_number_id || runtime.waCloudPhoneNumberId || "").trim(),
    accessToken: String(conn?.access_token || runtime.waCloudAccessToken || "").trim()
  };
};

const sendMetaTemplate = async (companyId: number | undefined, to: string, templateName: string, lang: string) => {
  const { phoneNumberId, accessToken } = await resolveCloudCredentials(companyId);
  if (!phoneNumberId || !accessToken) throw new Error("Cloud API credentials missing");

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang || "en" }
    }
  };

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Meta template send failed (${res.status})`);
  }

  const messageId = data?.messages?.[0]?.id || crypto.randomUUID();
  return { messageId, raw: data };
};

const findOrCreateTicket = async (contact: Contact, whatsappId: number, companyId: number) => {
  let ticket = await Ticket.findOne({
    where: {
      contactId: contact.id,
      whatsappId,
      status: { [Op.ne]: "closed" }
    },
    order: [["updatedAt", "DESC"]]
  });

  if (!ticket) {
    ticket = await Ticket.create({
      companyId,
      contactId: contact.id,
      whatsappId,
      status: "open",
      unreadMessages: 0,
      lastMessage: "",
      isGroup: false
    } as any);
  }

  return ticket;
};

const CheckInactiveContactsService = async () => {
  const now = Date.now();
  const runtime = getRuntimeSettings();

  const contacts = await Contact.findAll({
    where: {
      number: { [Op.ne]: null }
    } as any
  });

  let defaultWa: any = null;
  if (runtime.waCloudDefaultWhatsappId) {
    defaultWa = await Whatsapp.findByPk(runtime.waCloudDefaultWhatsappId);
  }
  if (!defaultWa) defaultWa = await Whatsapp.findOne({ where: { isDefault: true } });
  if (!defaultWa) defaultWa = await Whatsapp.findOne();

  for (const c of contacts) {
    const number = String((c as any).number || "").replace(/\D/g, "");
    if (!number) continue;

    // Solo recaptar leads abiertos con conversación activa
    const activeTicket = await Ticket.findOne({
      where: {
        contactId: c.id,
        companyId: (c as any).companyId,
        status: { [Op.in]: ["open", "pending"] }
      },
      order: [["updatedAt", "DESC"]]
    } as any);

    if (!activeTicket) continue;

    // Si el lead está marcado como leído/cerrado, no recaptar
    const leadStatus = String((c as any).leadStatus || "").toLowerCase();
    if (["read", "closed", "won", "lost"].includes(leadStatus)) continue;

    // Debe existir conversación y el último mensaje debe ser nuestro (lead no respondió)
    const lastMsg: any = await Message.findOne({
      where: { ticketId: (activeTicket as any).id },
      order: [["createdAt", "DESC"]]
    } as any);

    if (!lastMsg) continue;
    if (!(lastMsg as any).fromMe) continue;

    // Debe existir al menos 1 mensaje entrante del lead; evita recaptar leads recién creados sin respuesta
    const inboundCount = await Message.count({
      where: { ticketId: (activeTicket as any).id, fromMe: false }
    } as any);
    if (!inboundCount || Number(inboundCount) <= 0) continue;

    const inactivityMinutesContact = Number((c as any).inactivityMinutes || 0);
    // contacts.inactivityMinutes tiene default histórico 30; si queda ese default, usar setting global.
    const useContactOverride = Number.isFinite(inactivityMinutesContact) && inactivityMinutesContact > 0 && inactivityMinutesContact !== 30;
    const inactivityMinutes = useContactOverride
      ? inactivityMinutesContact
      : Number(runtime.waRecapInactivityMinutes || 4320);

    const last = (c as any).lastInteractionAt
      ? new Date((c as any).lastInteractionAt).getTime()
      : new Date((c as any).updatedAt || (c as any).createdAt || Date.now()).getTime();

    if (!last || !inactivityMinutes) continue;

    const dueMs = inactivityMinutes * 60_000;
    if (now - last < dueMs) continue;

    const lastFired = (c as any).lastInactivityFiredAt
      ? new Date((c as any).lastInactivityFiredAt).getTime()
      : 0;

    if (lastFired && lastFired >= last) continue;

    if (runtime.waRecapEnabled && runtime.waRecapTemplateName) {
      try {
        const { messageId } = await sendMetaTemplate(
          (c as any).companyId,
          number,
          runtime.waRecapTemplateName,
          runtime.waRecapTemplateLang || "en"
        );

        if (defaultWa) {
          const ticket = activeTicket;
          const body = `[TEMPLATE:${runtime.waRecapTemplateName}] Recaptación automática por inactividad (${Math.round(inactivityMinutes / 60)} h)`;

          const msg = await Message.create({
            id: messageId,
            body,
            contactId: c.id,
            ticketId: ticket.id,
            fromMe: true,
            read: true,
            ack: 1,
            mediaType: "chat"
          } as any);

          await ticket.update({ lastMessage: body, updatedAt: new Date() } as any);

          try {
            const io = getIO();
            io.to(`ticket-${ticket.id}`).emit("appMessage", {
              action: "create",
              message: msg,
              ticket,
              contact: c
            });
          } catch {}
        }

        await (c as any).update({ lastInactivityFiredAt: new Date() } as any);
        console.log(`[inactivity] template recapture sent contact=${c.id} number=${number}`);
      } catch (err: any) {
        console.error(`[inactivity] template recapture failed contact=${c.id}:`, err?.message || err);
      }
    }

    const webhookId = (c as any).inactivityWebhookId;
    if (webhookId) {
      const webhook = await Webhook.findByPk(webhookId);
      if (webhook && (webhook as any).active) {
        const payload = {
          event: "contact.inactive",
          contact: {
            id: c.id,
            name: (c as any).name,
            number: (c as any).number,
            email: (c as any).email,
            source: (c as any).source,
            leadStatus: (c as any).leadStatus,
            assignedUserId: (c as any).assignedUserId,
            lastInteractionAt: (c as any).lastInteractionAt,
            inactivityMinutes
          },
          timestamp: new Date().toISOString()
        };

        try {
          const safeUrl = await assertSafeWebhookUrl(String((webhook as any).url || ""));
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 8000);
          const res = await fetch(safeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: ctl.signal
          });
          clearTimeout(t);
          await safeJson(res);
          await (c as any).update({ lastInactivityFiredAt: new Date() } as any);
          console.log(`[inactivity] fired webhook ${webhookId} for contact ${c.id}`);
        } catch (err: any) {
          console.error(`[inactivity] webhook failed for contact ${c.id}:`, err?.message || err);
        }
      }
    }
  }
};

export default CheckInactiveContactsService;
