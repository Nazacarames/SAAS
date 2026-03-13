jest.mock("../../database", () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock("../../services/TokkoServices/TokkoService", () => ({ syncLeadToTokko: jest.fn() }));
jest.mock("../../middleware/isAuth", () => ({ __esModule: true, default: (_req: any, _res: any, next: any) => next() }));
jest.mock("../../middleware/isAdmin", () => ({ __esModule: true, default: (_req: any, _res: any, next: any) => next() }));
jest.mock("../../services/SettingsServices/RuntimeSettingsService", () => ({
  getRuntimeSettings: () => ({}),
  saveRuntimeSettings: jest.fn()
}));
jest.mock("../../routes/metaWebhookRoutes", () => ({ getMetaWebhookMetrics: jest.fn(), getMetaWebhookAlerts: jest.fn() }));
jest.mock("../../services/ContactServices/CheckInactiveContactsService", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../libs/socket", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));
jest.mock("../../helpers/jwt", () => ({
  createAccessToken: jest.fn(),
  verifyAccessToken: jest.fn(),
  createRefreshToken: jest.fn(),
  verifyRefreshToken: jest.fn()
}));
jest.mock("../../routes/integrations/integrationRoutes", () => ({ getIntegrationHardeningMetrics: jest.fn(), getIntegrationHardeningAlertSnapshot: jest.fn() }));
jest.mock("../../services/WhatsAppCloudServices/ProcessCloudWebhookService", () => ({ getWaHardeningMetrics: jest.fn(), getWaHardeningAlertSnapshot: jest.fn() }));
jest.mock("../../services/MessageServices/SendMessageService", () => ({ getSendHardeningMetrics: jest.fn(), getSendHardeningAlertSnapshot: jest.fn() }));

import sequelize from "../../database";
import { syncLeadToTokko } from "../../services/TokkoServices/TokkoService";
import { applyLeadStatusAndTokkoSync } from "../../routes/aiRoutes";

describe("critical/cierre -> status Tokko", () => {
  it("al cerrar lead perdido, actualiza contacto y sincroniza estado a Tokko", async () => {
    (sequelize.query as jest.Mock)
      .mockResolvedValueOnce([{ id: 55, name: "Lead", number: "5493411234567", email: "lead@x.com", needs: "" }])
      .mockResolvedValue([])
      .mockResolvedValue([]);

    (syncLeadToTokko as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const out: any = await applyLeadStatusAndTokkoSync({
      companyId: 1,
      contactId: 55,
      status: "lost",
      lossReason: "sin presupuesto"
    });

    expect(syncLeadToTokko).toHaveBeenCalledWith(expect.objectContaining({
      source: "lead-close-status-sync",
      message: expect.stringContaining("estado=lost")
    }));
    expect(out.ok).toBe(true);
    expect(out.tokko.synced).toBe(true);
  });
});
