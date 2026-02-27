import Whatsapp from "../../models/Whatsapp";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";

interface ListWhatsappsRequest {
    companyId: number;
}

const ListWhatsappsService = async ({ companyId }: ListWhatsappsRequest): Promise<Whatsapp[]> => {
    const whatsapps = await Whatsapp.findAll({
        where: { companyId },
        attributes: ["id", "name", "status", "qrcode", "battery", "plugged", "isDefault"],
        order: [["name", "ASC"]]
    });

    const runtime = getRuntimeSettings();

    // If Cloud API credentials are configured, reflect that in the default whatsapp connection status.
    const cloudConfigured = Boolean(runtime.waCloudPhoneNumberId && runtime.waCloudAccessToken);
    const cloudId = Number(runtime.waCloudDefaultWhatsappId || 0);

    const normalized = whatsapps.map((w: any) => {
        if (cloudConfigured && cloudId && w.id === cloudId) {
            return { ...w.toJSON(), status: "CONNECTED", plugged: true };
        }
        return w.toJSON ? w.toJSON() : w;
    });

    return normalized as any;
};

export default ListWhatsappsService;
