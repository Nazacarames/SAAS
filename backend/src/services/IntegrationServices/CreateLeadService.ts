import Contact from "../../models/Contact";
import Whatsapp from "../../models/Whatsapp";
import AppError from "../../errors/AppError";

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

  if (!contact) {
    contact = await Contact.create({
      companyId,
      name: name || normalized,
      number: normalized,
      email: email || "",
      profilePicUrl: "",
      isGroup: false,
      whatsappId: wa.id
    });
  }

  return { conversationId: contact.id, contact };
};

export default CreateLeadService;
