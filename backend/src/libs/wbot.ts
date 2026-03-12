import Whatsapp from "../models/Whatsapp";

// Baileys removed: Cloud API only runtime.
const sessions: Record<number, null> = {};

export const getWbot = (_whatsappId: number): null => null;

export const removeWbot = (whatsappId: number): void => {
  delete sessions[whatsappId];
};

export const initWbot = async (whatsapp: Whatsapp): Promise<null> => {
  await whatsapp.update({ status: "DISCONNECTED", qrcode: null } as any);
  return null;
};

export const initWbots = async (): Promise<void> => {
  const whatsapps = await Whatsapp.findAll();
  for (const w of whatsapps) {
    await w.update({ status: "DISCONNECTED", qrcode: null } as any);
  }
};
