import "./instrument";
import dotenv from "dotenv";
import app from "./app";
import sequelize from "./database";
import http from "http";
import path from "path";
import { initIO } from "./libs/socket";
import { syncTokkoLocationsToKnowledge } from "./services/TokkoServices/TokkoService";
import { addRecurringJob, closeAllQueues, QUEUE_NAMES } from "./services/QueueService";
import { startInactivityCheckWorker, stopInactivityCheckWorker, startAIProcessingWorker, stopAIProcessingWorker } from "./workers";

dotenv.config();

const requiredEnv = ["JWT_SECRET", "JWT_REFRESH_SECRET"];
const missing = requiredEnv.filter((k) => !String(process.env[k] || "").trim());
if (missing.length) {
  console.error("✗ Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

if (!process.env.NODE_ENV) {
  console.warn("⚠ NODE_ENV not set — defaulting to 'development'. Set NODE_ENV=production for production deployments.");
}

const NODE_ENV = process.env.NODE_ENV || "development";
console.log(`✓ Environment: ${NODE_ENV}`);

const PORT = process.env.PORT || 4000;
const TOKKO_KB_SYNC_INTERVAL_MS = Math.max(60_000, Number(process.env.TOKKO_KB_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000));
const TOKKO_KB_SYNC_COMPANY_ID = Number(process.env.TOKKO_KB_SYNC_COMPANY_ID || 1);

let tokkoKbSyncRunning = false;
const runTokkoKnowledgeSync = async () => {
  if (tokkoKbSyncRunning) return;
  tokkoKbSyncRunning = true;
  try {
    const result: any = await syncTokkoLocationsToKnowledge(TOKKO_KB_SYNC_COMPANY_ID);
    if (result?.ok) {
      console.log(`[tokko-kb-sync] ok company=${TOKKO_KB_SYNC_COMPANY_ID} locations=${result?.locations || 0} doc=${result?.documentId || "n/a"}`);
    } else {
      console.warn(`[tokko-kb-sync] skipped/error`, result);
    }
  } catch (err: any) {
    console.error(`[tokko-kb-sync] failed:`, err?.message || err);
  } finally {
    tokkoKbSyncRunning = false;
  }
};

const server = http.createServer(app);

// Socket.io setup (shared via libs/socket -> getIO())
initIO(server);

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    server.close(() => {
      console.log("[Server] HTTP server closed");
    });

    // Close queue workers
    await stopInactivityCheckWorker();
    await stopAIProcessingWorker();
    await closeAllQueues();
    console.log("[Server] Queue workers closed");

    // Close database connection
    await sequelize.close();
    console.log("[Server] Database connection closed");

    process.exit(0);
  } catch (error: any) {
    console.error("[Server] Error during shutdown:", error?.message || error);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Database connection and server start
const startServer = async () => {
  try {
    sequelize.addModels([path.join(__dirname, "models")]);
    await sequelize.authenticate();
    console.log("✓ Database connection established successfully");

    console.log("✓ Database ready (run 'npm run db:migrate' for schema changes)");

    // Start BullMQ worker for inactivity checks
    await startInactivityCheckWorker();
    await startAIProcessingWorker();

    // Schedule recurring inactivity check job (every minute)
    await addRecurringJob(QUEUE_NAMES.INACTIVITY_CHECK, "inactivity-scan", {}, "* * * * *");

    server.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);

      // Keep Tokko locations knowledge document refreshed automatically (default: every 24h)
      setTimeout(() => { runTokkoKnowledgeSync(); }, 15_000);
      setInterval(() => { runTokkoKnowledgeSync(); }, TOKKO_KB_SYNC_INTERVAL_MS);
    });
  } catch (error: any) {
    console.error("✗ Unable to start server:", error?.message || error);
    process.exit(1);
  }
};

startServer();
