import Contact from "../../models/Contact";
import Whatsapp from "../../models/Whatsapp";
import AppError from "../../errors/AppError";
import { syncLeadToTokko } from "../TokkoServices/TokkoService";
import Tag from "../../models/Tag";
import ContactTag from "../../models/ContactTag";

interface CreateLeadRequest {
  companyId: number;
  whatsappId?: number;
  name: string;
  number: string;
  email?: string;
  source?: string;
  notes?: string;
  metadata?: any;
}

const normalizeNumber = (raw: string): string => (raw || "").replace(/\D/g, "");

const CreateLeadService = async (data: CreateLeadRequest) => {
  const { companyId, whatsappId, name, number, email } = data;

  const normalized = normalizeNumber(number);
  if (!normalized) throw new AppError("Invalid lead number", 400);

  const wa = whatsappId
    ? await Whatsapp.findOne({ where: { id: whatsappId, companyId } })
    : await Whatsapp.findOne({ where: { companyId, isDefault: true } });

  if (!wa) throw new AppError("No WhatsApp connection available", 400);

  let contact = await Contact.findOne({ where: { companyId, number: normalized } });

  const isNew = !contact;
  if (!contact) {
    contact = await Contact.create({
      companyId,
      name: name || normalized,
      number: normalized,
      email: email || "",
      profilePicUrl: "",
      isGroup: false,
      whatsappId: wa.id,
      source: data.source || "integration_api"
    });
  }

  let tokko: any = { ok: false, skipped: true, reason: "existing_contact" };
  if (isNew) {
    tokko = await syncLeadToTokko({
      name: name || normalized,
      phone: normalized,
      email: email || "",
      message: String(data.notes || "Nuevo lead recibido por API de integraciones").slice(0, 500),
      source: data.source || "integrations-api"
    });

    if (tokko?.ok && contact?.id) {
      const [tag] = await Tag.findOrCreate({ where: { name: "enviado_tokko" }, defaults: { name: "enviado_tokko", color: "#0EA5E9" } });
      const exists = await ContactTag.findOne({ where: { contactId: Number(contact.id), tagId: Number(tag.id) } });
      if (!exists) {
        await ContactTag.create({ contactId: Number(contact.id), tagId: Number(tag.id) } as any);
      }
    }
  }

  return { conversationId: contact.id, contact, tokko };
};

export default CreateLeadService;
