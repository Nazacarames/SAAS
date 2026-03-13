jest.mock("../../models/Whatsapp", () => ({
  __esModule: true,
  default: { findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn() }
}));
jest.mock("../../models/Contact", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn(), findByPk: jest.fn() }
}));
jest.mock("../../models/Ticket", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn() }
}));
jest.mock("../../models/Message", () => ({
  __esModule: true,
  default: { findByPk: jest.fn(), create: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), count: jest.fn() }
}));
jest.mock("../../models/Tag", () => ({ __esModule: true, default: { findOrCreate: jest.fn() } }));
jest.mock("../../models/ContactTag", () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));

jest.mock("../../database", () => ({
  __esModule: true,
  default: { query: jest.fn() }
}));

jest.mock("../../libs/socket", () => ({
  getIO: () => ({ to: () => ({ emit: jest.fn() }) })
}));

jest.mock("../../services/SettingsServices/RuntimeSettingsService", () => ({
  getRuntimeSettings: () => ({
    waCloudDefaultWhatsappId: 0,
    waWebhookMaxMessageAgeSeconds: 86400,
    waWebhookFutureSkewSeconds: 300,
    waInboundReplayFailClosed: true,
    waInboundReplayMaxBlocksPerPayload: 40,
    waOutboundRetryMaxAttempts: 1
  })
}));

import Whatsapp from "../../models/Whatsapp";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import sequelize from "../../database";
import { processCloudWebhookPayload } from "../../services/WhatsAppCloudServices/ProcessCloudWebhookService";

describe("critical/webhook inbound + dedupe", () => {
  it("procesa primer inbound y bloquea replay del mismo message id", async () => {
    (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 10, companyId: 1 });
    (Contact.findOne as jest.Mock).mockResolvedValue(null);
    (Contact.create as jest.Mock).mockResolvedValue({ id: 20, number: "5493411234567", update: jest.fn() });
    (Ticket.findOne as jest.Mock).mockResolvedValue(null);
    (Ticket.create as jest.Mock).mockResolvedValue({ id: 30, companyId: 1, status: "pending", unreadMessages: 0, update: jest.fn(), lastMessage: "" });
    (Message.findByPk as jest.Mock).mockResolvedValue(null);
    (Message.create as jest.Mock).mockResolvedValue({ id: "wamid.1" });
    (Message.findAll as jest.Mock).mockResolvedValue([]);
    let replayReserveCalls = 0;
    (sequelize.query as jest.Mock).mockImplementation(async (sql: string) => {
      const s = String(sql || "");
      if (s.includes("INSERT INTO ai_inbound_replay_guard")) {
        replayReserveCalls += 1;
        return replayReserveCalls === 1 ? [{ replay_key: "rk1" }] : [];
      }
      if (s.includes("INSERT INTO ai_decision_logs")) return [];
      return [];
    });

    const payload = {
      entry: [{
        changes: [{
          value: {
            messages: [
              { id: "wamid.1", from: "5493411234567", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hola" } },
              { id: "wamid.1", from: "5493411234567", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hola" } }
            ]
          }
        }]
      }]
    } as any;

    const out = await processCloudWebhookPayload(payload);

    expect(out.processed).toBe(1);
    expect(out.ignored).toBe(1);
    expect(Message.create).toHaveBeenCalledTimes(1);
  });
});
