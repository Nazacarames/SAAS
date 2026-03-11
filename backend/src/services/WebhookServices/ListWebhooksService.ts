import Webhook from "../../models/Webhook";

interface ListWebhooksRequest {
    companyId?: number;
}

const ListWebhooksService = async (data?: ListWebhooksRequest) => {
    const webhooks = await Webhook.findAll({
        order: [["createdAt", "DESC"]]
    });
    return webhooks;
};

export default ListWebhooksService;
