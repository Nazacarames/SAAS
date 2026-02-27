import Whatsapp from "../../models/Whatsapp";
import AppError from "../../errors/AppError";

interface CreateWhatsappRequest {
    name: string;
    companyId: number;
    isDefault?: boolean;
}

const CreateWhatsappService = async (data: CreateWhatsappRequest): Promise<Whatsapp> => {
    const { name, companyId, isDefault = false } = data;

    const whatsapp = await Whatsapp.create({
        name,
        companyId,
        status: "DISCONNECTED",
        isDefault
    });

    return whatsapp;
};

export default CreateWhatsappService;
