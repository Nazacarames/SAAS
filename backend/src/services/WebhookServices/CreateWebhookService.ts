import Webhook from "../../models/Webhook";

interface CreateWebhookRequest {
    name: string;
    url: string;
    event: string;
    active?: boolean;
    description?: string;
}

const CreateWebhookService = async (data: CreateWebhookRequest) => {
    const webhook = await Webhook.create({
        name: data.name,
        url: data.url,
        event: data.event,
        active: data.active !== undefined ? data.active : true,
        description: data.description || ""
    } as any);
    return webhook;
};

export default CreateWebhookService;
