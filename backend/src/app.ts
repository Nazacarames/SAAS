import express, { Application } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import "express-async-errors";
import errorHandler from "./middleware/errorHandler";
import { getMessageStats } from "./utils/messageStats";
import { getMetaWebhookAlerts, getMetaWebhookMetrics } from "./routes/metaWebhookRoutes";
import { requestContext } from "./middleware/requestContext";

const app: Application = express();

// Security headers via helmet
app.use(helmet({ contentSecurityPolicy: false }));

// Cookie parser
app.use(cookieParser());

// CORS
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true
}));

// Body parsers with size limits
app.use(express.json({ limit: "2mb", verify: (req: any, _res, buf) => { (req as any).rawBody = buf?.toString("utf8") || ""; } }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(requestContext);

// Static files
app.use("/public", express.static("public"));

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/health/messages", (req, res) => {
    const stats = getMessageStats();
    res.json({ status: "ok", timestamp: new Date().toISOString(), stats, alerts: [] });
});

app.get("/api/health/messages", (req, res) => {
    const stats = getMessageStats();
    res.json({ status: "ok", timestamp: new Date().toISOString(), stats, alerts: [] });
});

app.get("/health/meta-webhook", (req, res) => {
    const stats = getMetaWebhookMetrics();
    const alerts = getMetaWebhookAlerts();
    res.json({ status: alerts.some((a: any) => a.severity === "critical") ? "degraded" : "ok", timestamp: new Date().toISOString(), stats, alerts });
});

app.get("/api/health/meta-webhook", (req, res) => {
    const stats = getMetaWebhookMetrics();
    const alerts = getMetaWebhookAlerts();
    res.json({ status: alerts.some((a: any) => a.severity === "critical") ? "degraded" : "ok", timestamp: new Date().toISOString(), stats, alerts });
});

// Routes
import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import whatsappRoutes from "./routes/whatsappRoutes";
import contactRoutes from "./routes/contactRoutes";
import conversationRoutes from "./routes/conversationRoutes";
import messageRoutes from "./routes/messageRoutes";
import webhookRoutes from "./routes/webhookRoutes";
import metaWebhookRoutes from "./routes/metaWebhookRoutes";
import whatsappCloudRoutes from "./routes/whatsappCloudRoutes";
import integrationRoutes from "./routes/integrations/integrationRoutes";
import settingsRoutes from "./routes/settingsRoutes";
import aiRoutes from "./routes/aiRoutes";
import savedReplyRoutes from "./routes/savedReplyRoutes";
import billingRoutes from "./routes/billingRoutes";
import chatwootRoutes from "./routes/chatwootRoutes";
import Webhook from "./models/Webhook";

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/whatsapps", whatsappRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/meta", metaWebhookRoutes);
app.use("/api/whatsapp-cloud", whatsappCloudRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/saved-replies", savedReplyRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/chatwoot", chatwootRoutes);


// Error handler (must be last)
app.use(errorHandler);

export default app;
