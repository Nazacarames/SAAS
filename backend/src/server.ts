import dotenv from "dotenv";
import app from "./app";
import sequelize from "./database";
import http from "http";
import path from "path";
import { initIO } from "./libs/socket";
import { initWbots } from "./libs/wbot";
import CheckInactiveContactsService from "./services/ContactServices/CheckInactiveContactsService";

dotenv.config();

const requiredEnv = ["JWT_SECRET", "JWT_REFRESH_SECRET"];
const missing = requiredEnv.filter((k) => !String(process.env[k] || "").trim());
if (missing.length) {
  console.error("✗ Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);

// Socket.io setup (shared via libs/socket -> getIO())
initIO(server);

// Database connection and server start
const startServer = async () => {
  try {
    sequelize.addModels([path.join(__dirname, "models")]);
    await sequelize.authenticate();
    console.log("✓ Database connection established successfully");

    // Restore WhatsApp sessions (if any)
    try {
      await Promise.race([
        initWbots(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("initWbots timeout after 15s")), 15000)
        )
      ]);
      console.log("✓ WhatsApp sessions initialized");
    } catch (err: any) {
      console.error("! WhatsApp sessions init failed:", err?.message || err);
    }

    // Sync models only in development to avoid destructive resets in production
    if ((process.env.NODE_ENV || "development") !== "production") {
      await sequelize.sync({ alter: true });
      console.log("✓ Database models synchronized (dev)");
    }

    server.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: `);

      setInterval(() => {
        CheckInactiveContactsService().catch((e: any) => console.error("inactivity scan error:", e?.message || e));
      }, 60_000);
    });
  } catch (error: any) {
    console.error("✗ Unable to start server:", error?.message || error);
    process.exit(1);
  }
};

startServer();
