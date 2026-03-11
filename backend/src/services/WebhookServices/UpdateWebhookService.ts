import Webhook from "../../models/Webhook";
import AppError from "../../errors/AppError";

interface UpdateWebhookRequest {
    webhookId: number;
    companyId: number;
    name?: string;
    url?: string;
    event?: string;
    active?: boolean;
    description?: string;
}

const UpdateWebhookService = async (data: UpdateWebhookRequest) => {
    const webhook = await Webhook.findOne({
        where: { id: data.webhookId, companyId: data.companyId }
    });

    if (!webhook) {
        throw new AppError("Webhook no encontrado", 404);
    }

    await webhook.update({
        name: data.name || webhook.name,
        url: data.url || webhook.url,
        event: data.event || webhook.event,
        active: data.active !== undefined ? data.active : webhook.active,
        description: data.description !== undefined ? data.description : webhook.description
    });

    return webhook;
};

export default UpdateWebhookService;
