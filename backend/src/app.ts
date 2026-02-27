import express, { Application } from "express";
import cors from "cors";
import "express-async-errors";
import errorHandler from "./middleware/errorHandler";
import { getMessageStats } from "./utils/messageStats";

const app: Application = express();

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true
}));

app.use(express.json({ verify: (req: any, _res, buf) => { (req as any).rawBody = buf?.toString("utf8") || ""; } }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use("/public", express.static("public"));

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/health/messages", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), stats: getMessageStats() });
});

app.get("/api/health/messages", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), stats: getMessageStats() });
});

// Routes
import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import whatsappRoutes from "./routes/whatsappRoutes";
import contactRoutes from "./routes/contactRoutes";
import conversationRoutes from "./routes/conversationRoutes";
import messageRoutes from "./routes/messageRoutes";
import sessionRoutes from "./routes/sessionRoutes";
import webhookRoutes from "./routes/webhookRoutes";
import metaWebhookRoutes from "./routes/metaWebhookRoutes";
import whatsappCloudRoutes from "./routes/whatsappCloudRoutes";
import integrationRoutes from "./routes/integrations/integrationRoutes";
import settingsRoutes from "./routes/settingsRoutes";
import aiRoutes from "./routes/aiRoutes";
import savedReplyRoutes from "./routes/savedReplyRoutes";
import Webhook from "./models/Webhook";

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/whatsapps", whatsappRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/meta", metaWebhookRoutes);
app.use("/api/whatsapp-cloud", whatsappCloudRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/saved-replies", savedReplyRoutes);


// Temporary endpoint to sync webhooks table (development only)
if ((process.env.NODE_ENV || "development") !== "production") {
    app.post("/api/sync-webhooks", async (req, res) => {
        try {
            await Webhook.sync({ alter: true });
            const count = await Webhook.count();
            res.json({ success: true, message: "Tabla webhooks sincronizada", count });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

// Error handler (must be last)
app.use(errorHandler);

export default app;
