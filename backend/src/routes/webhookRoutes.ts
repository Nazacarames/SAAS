import { Router, Request } from "express";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import CreateWebhookService from "../services/WebhookServices/CreateWebhookService";
import ListWebhooksService from "../services/WebhookServices/ListWebhooksService";
import UpdateWebhookService from "../services/WebhookServices/UpdateWebhookService";
import DeleteWebhookService from "../services/WebhookServices/DeleteWebhookService";

interface AuthRequest extends Request {
    user?: {
        id: number;
        email: string;
        profile: string;
        companyId: number;
    };
}

const webhookRoutes = Router();

// List all webhooks (company-scoped)
webhookRoutes.get("/", isAuth, isAdmin, async (req: any, res) => {
    const { companyId } = req.user;
    const webhooks = await ListWebhooksService({ companyId });
    return res.json(webhooks);
});

// Create new webhook
webhookRoutes.post("/", isAuth, isAdmin, async (req: any, res) => {
    const { companyId } = req.user;
    const { name, url, event, active, description } = req.body;

    const webhook = await CreateWebhookService({
        name,
        url,
        event,
        active,
        description,
        companyId
    });

    return res.status(201).json(webhook);
});

// Update webhook
webhookRoutes.put("/:webhookId", isAuth, isAdmin, async (req: any, res) => {
    const { companyId } = req.user;
    const { webhookId } = req.params;
    const { name, url, event, active, description } = req.body;

    const webhook = await UpdateWebhookService({
        webhookId: parseInt(webhookId),
        companyId,
        name,
        url,
        event,
        active,
        description
    });

    return res.json(webhook);
});

// Delete webhook
webhookRoutes.delete("/:webhookId", isAuth, isAdmin, async (req: any, res) => {
    const { companyId } = req.user;
    const { webhookId } = req.params;

    await DeleteWebhookService({ webhookId: parseInt(webhookId), companyId });

    return res.status(204).send();
});

export default webhookRoutes;
