import Whatsapp from "../../models/Whatsapp";
import AppError from "../../errors/AppError";

interface ShowWhatsappRequest {
  whatsappId: number;
  companyId: number;
}

const ShowWhatsappService = async ({ whatsappId, companyId }: ShowWhatsappRequest): Promise<Whatsapp> => {
  const whatsapp = await Whatsapp.findOne({
    where: { id: whatsappId, companyId },
    attributes: [
      "id",
      "name",
      "status",
      "qrcode",
      "battery",
      "plugged",
      "isDefault",
      "greetingMessage",
      "farewellMessage",
      "createdAt",
      "updatedAt"
    ]
  });

  if (!whatsapp) {
    throw new AppError("WhatsApp connection not found", 404);
  }

  return whatsapp;
};

export default ShowWhatsappService;
