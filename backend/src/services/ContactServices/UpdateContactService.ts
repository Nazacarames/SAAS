import Contact from "../../models/Contact";
import AppError from "../../errors/AppError";
import Tag from "../../models/Tag";
import UpsertTagsService from "../TagServices/UpsertTagsService";

interface Request {
  companyId: number;
  contactId: number;
  name?: string;
  number?: string;
  email?: string;
  whatsappId?: number | null;
  source?: string;
  leadStatus?: string;
  assignedUserId?: number | null;
  inactivityMinutes?: number;
  inactivityWebhookId?: number | null;
  tags?: string[];
}

const UpdateContactService = async ({
  companyId,
  contactId,
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
  const contact = await Contact.findOne({ where: { id: contactId, companyId } });
  if (!contact) throw new AppError("Contacto no encontrado", 404);

  await contact.update({
    name: typeof name === "string" ? name : contact.name,
    number: typeof number === "string" ? number.replace(/\D/g, "") : contact.number,
    email: typeof email === "string" ? email : contact.email,
    whatsappId: whatsappId === undefined ? contact.whatsappId : whatsappId,
    source: source === undefined ? (contact as any).source : source,
    leadStatus: leadStatus === undefined ? (contact as any).leadStatus : leadStatus,
    assignedUserId: assignedUserId === undefined ? (contact as any).assignedUserId : assignedUserId,
    inactivityMinutes: typeof inactivityMinutes === "number" ? inactivityMinutes : (contact as any).inactivityMinutes,
    inactivityWebhookId: inactivityWebhookId === undefined ? (contact as any).inactivityWebhookId : inactivityWebhookId
  } as any);

  if (tags) {
    const tagModels = await UpsertTagsService(tags);
    await (contact as any).$set("tags", tagModels);
  }

  const reloaded = await Contact.findByPk(contact.id, { include: [{ model: Tag, as: "tags" }] });
  return reloaded || contact;
};

export default UpdateContactService;
