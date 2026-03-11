import Webhook from "../../models/Webhook";
import AppError from "../../errors/AppError";

interface DeleteWebhookRequest {
    webhookId: number;
}

const DeleteWebhookService = async ({ webhookId }: DeleteWebhookRequest) => {
    const webhook = await Webhook.findByPk(webhookId);

    if (!webhook) {
        throw new AppError("Webhook no encontrado", 404);
    }

    await webhook.destroy();
};

export default DeleteWebhookService;
