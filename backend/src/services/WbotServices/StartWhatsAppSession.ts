import Whatsapp from "../../models/Whatsapp";
import { initWbot } from "../../libs/wbot";
import AppError from "../../errors/AppError";

interface StartWhatsAppSessionRequest {
  whatsappId: number;
}

// Start WhatsApp session asynchronously: return immediately and send QR/status via Socket.io.
const StartWhatsAppSession = async ({ whatsappId }: StartWhatsAppSessionRequest): Promise<void> => {
  const whatsapp = await Whatsapp.findByPk(whatsappId);

  if (!whatsapp) {
    throw new AppError("Conexión WhatsApp no encontrada", 404);
  }

  await whatsapp.update({ status: "OPENING" });

  initWbot(whatsapp).catch(async (err: any) => {
    console.error("initWbot error:", err?.message || err);
    try {
      await whatsapp.update({ status: "DISCONNECTED" });
    } catch {}
  });
};

export default StartWhatsAppSession;
