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

// List all webhooks
webhookRoutes.get("/", isAuth, isAdmin, async (req, res) => {
    try {
        const webhooks = await ListWebhooksService();
        return res.json(webhooks);
    } catch (error: any) {
        console.error("Error listing webhooks:", error);
        return res.status(500).json({ error: error.message });
    }
});

// Create new webhook
webhookRoutes.post("/", isAuth, isAdmin, async (req, res) => {
    try {
        const { name, url, event, active, description } = req.body;

        const webhook = await CreateWebhookService({
            name,
            url,
            event,
            active,
            description
        });

        return res.status(201).json(webhook);
    } catch (error: any) {
        console.error("Error creating webhook:", error);
        return res.status(500).json({ error: error.message });
    }
});

// Update webhook
webhookRoutes.put("/:webhookId", isAuth, isAdmin, async (req, res) => {
    try {
        const { webhookId } = req.params;
        const { name, url, event, active, description } = req.body;

        const webhook = await UpdateWebhookService({
            webhookId: parseInt(webhookId),
            name,
            url,
            event,
            active,
            description
        });

        return res.json(webhook);
    } catch (error: any) {
        console.error("Error updating webhook:", error);
        return res.status(500).json({ error: error.message });
    }
});

// Delete webhook
webhookRoutes.delete("/:webhookId", isAuth, isAdmin, async (req, res) => {
    try {
        const { webhookId } = req.params;

        await DeleteWebhookService({ webhookId: parseInt(webhookId) });

        return res.status(204).send();
    } catch (error: any) {
        console.error("Error deleting webhook:", error);
        return res.status(500).json({ error: error.message });
    }
});

export default webhookRoutes;
