import Contact from "../../models/Contact";
import Tag from "../../models/Tag";
import User from "../../models/User";
import Ticket from "../../models/Ticket";
import Whatsapp from "../../models/Whatsapp";
import UpsertTagsService from "../TagServices/UpsertTagsService";
import { Op } from "sequelize";

const normalizeWhatsAppNumber = (raw: string): string => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("549") && digits.length >= 12) return digits;
  if (digits.startsWith("54") && digits.length >= 12) return digits;
  if (digits.length === 10 && digits.startsWith("11")) return `549${digits}`;
  if (digits.length === 10) return `54${digits}`;
  return digits;
};


const pickAutoAssignedUserId = async (companyId: number): Promise<number | null> => {
  const users = await User.findAll({
    where: { companyId },
    attributes: ["id", "profile"],
    order: [["id", "ASC"]]
  });

  const all = users.map((u: any) => ({ id: Number(u.id), profile: String(u.profile || "") }));
  if (!all.length) return null;

  const nonAdmin = all.filter((u) => u.profile.toLowerCase() !== "admin");
  const pool = nonAdmin.length ? nonAdmin : all;

  let winnerId: number | null = null;
  let minLoad = Number.POSITIVE_INFINITY;

  for (const u of pool) {
    const load = await Contact.count({
      where: {
        companyId,
        assignedUserId: u.id,
        leadStatus: { [Op.ne]: "read" }
      } as any
    });

    if (load < minLoad) {
      minLoad = load;
      winnerId = u.id;
    }
  }

  return winnerId;
};

interface Request {
  companyId: number;
  name: string;
  number: string;
  email?: string;
  whatsappId?: number | null;
  source?: string;
  leadStatus?: string;
  assignedUserId?: number | null;
  inactivityMinutes?: number;
  inactivityWebhookId?: number | null;
  tags?: string[];
}

const CreateContactService = async ({
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
}: Request) => {
  const resolvedAssignedUserId = typeof assignedUserId === "number"
    ? assignedUserId
    : await pickAutoAssignedUserId(companyId);

  const contact = await Contact.create({
    companyId,
    name,
    number: normalizeWhatsAppNumber(number),
    email: email || "",
    whatsappId: whatsappId || null,
    source: source || null,
    leadStatus: leadStatus || "unread",
    assignedUserId: resolvedAssignedUserId,
    inactivityMinutes: typeof inactivityMinutes === "number" ? inactivityMinutes : 30,
    inactivityWebhookId: inactivityWebhookId || null,
    lastInteractionAt: new Date()
  } as any);

  if (tags?.length) {
    const tagModels = await UpsertTagsService(tags, companyId);
    await (contact as any).$set("tags", tagModels);
  }

  try {
    const existing = await Ticket.findOne({
      where: {
        contactId: contact.id,
        companyId,
        status: { [Op.in]: ["pending", "open"] }
      } as any,
      order: [["updatedAt", "DESC"]]
    });

    if (!existing) {
      let resolvedWhatsappId = Number(whatsappId || 0);
      if (!resolvedWhatsappId) {
        const preferred = await Whatsapp.findOne({ where: { companyId, isDefault: true } });
        if (preferred) resolvedWhatsappId = Number((preferred as any).id || 0);
      }
      if (!resolvedWhatsappId) {
        const anyWa = await Whatsapp.findOne({ where: { companyId } });
        if (anyWa) resolvedWhatsappId = Number((anyWa as any).id || 0);
      }
      if (resolvedWhatsappId) {
        await Ticket.create({
          contactId: contact.id,
          whatsappId: resolvedWhatsappId,
          companyId,
          status: "pending",
          unreadMessages: 0,
          lastMessage: "",
          bot_enabled: true,
          human_override: false,
          userId: resolvedAssignedUserId || null
        } as any);
      }
    }
  } catch (err: any) {
    console.error(`[CreateContact] ticket auto-creation failed for contact ${contact.id}:`, err?.message || err);
  }

  const reloaded = await Contact.findByPk(contact.id, { include: [{ model: Tag, as: "tags" }] });
  return reloaded || contact;
};

export default CreateContactService;
