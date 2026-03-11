import Webhook from "../../models/Webhook";
import AppError from "../../errors/AppError";

interface DeleteWebhookRequest {
    webhookId: number;
    companyId: number;
}

const DeleteWebhookService = async ({ webhookId, companyId }: DeleteWebhookRequest) => {
    const webhook = await Webhook.findOne({
        where: { id: webhookId, companyId }
    });

    if (!webhook) {
        throw new AppError("Webhook no encontrado", 404);
    }

    await webhook.destroy();
};

export default DeleteWebhookService;
