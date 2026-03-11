import sequelize from "./src/database";
import Webhook from "./src/models/Webhook";

async function createWebhooksTable() {
    try {
        console.log("=== Sincronizando tabla Webhooks ===");

        // Force sync solo de la tabla Webhook
        await Webhook.sync({ force: false, alter: true });

        console.log("✓ Tabla webhooks creada/actualizada exitosamente");

        // Verificar
        const count = await Webhook.count();
        console.log(`✓ Total webhooks: ${count}`);

        process.exit(0);
    } catch (error) {
        console.error("✗ Error:", error);
        process.exit(1);
    }
}

createWebhooksTable();
