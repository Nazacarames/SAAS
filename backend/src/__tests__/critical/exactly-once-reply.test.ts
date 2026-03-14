/**
 * Critical test: exactly-once reply per inbound message.
 *
 * Scenario: orchestrator returns empty → direct Tokko search finds results →
 * bot should reply ONCE with Tokko options and NOT send a fallback.
 */

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
jest.mock("../../models/Tag", () => ({
  __esModule: true,
  default: { findOrCreate: jest.fn() }
}));
jest.mock("../../models/ContactTag", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn() }
}));

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
    waCloudPhoneNumberId: "12345",
    waCloudAccessToken: "fake-token",
    waWebhookMaxMessageAgeSeconds: 86400,
    waWebhookFutureSkewSeconds: 300,
    waInboundReplayFailClosed: true,
    waInboundReplayMaxBlocksPerPayload: 40,
    waOutboundRetryMaxAttempts: 1,
    waOutboundDedupeTtlSeconds: 120
  })
}));

jest.mock("../../services/AIServices/ConversationOrchestrator");
jest.mock("../../services/TokkoServices/TokkoService");
jest.mock("../../utils/phoneNormalization", () => ({
  __esModule: true,
  normalizeWaPhone: jest.fn((p: string) => String(p || "").replace(/\D/g, ""))
}));

import Whatsapp from "../../models/Whatsapp";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import Tag from "../../models/Tag";
import ContactTag from "../../models/ContactTag";
import sequelize from "../../database";
import { generateConversationalReply } from "../../services/AIServices/ConversationOrchestrator";
import { searchTokkoProperties } from "../../services/TokkoServices/TokkoService";
import { processCloudWebhookPayload } from "../../services/WhatsAppCloudServices/ProcessCloudWebhookService";

// Track all outbound send attempts through fetch mock
let fetchCalls: Array<{ url: string; body: any }> = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

describe("critical/exactly-once reply", () => {
  it("inbound con criterios completos produce exactamente 1 mensaje bot (Tokko directo, sin fallback)", async () => {
    // Setup mock implementations (resetMocks in jest.config clears them between tests)
    (generateConversationalReply as jest.Mock).mockResolvedValue({
      reply: "",
      model: "gpt-4o-mini",
      usedFallback: true,
      toolCallCount: 0,
      knowledge: [],
      tokko: { used: false, results: 0 }
    });

    (searchTokkoProperties as jest.Mock).mockResolvedValue({
      results: [
        { title: "Casa en Rosario", location: "Rosario Centro", price: 120000, rooms: 3, url: "https://tokko.test/1" },
        { title: "Depto en Fisherton", location: "Fisherton", price: 95000, rooms: 2, url: "https://tokko.test/2" }
      ]
    });

    // Whatsapp connection
    (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 10, companyId: 1 });

    // Contact
    const mockContact = { id: 20, number: "5493411234567", update: jest.fn().mockResolvedValue(undefined) };
    (Contact.findOne as jest.Mock).mockResolvedValue(null);
    (Contact.create as jest.Mock).mockResolvedValue(mockContact);

    // Ticket
    const mockTicket = {
      id: 30,
      companyId: 1,
      status: "open",
      unreadMessages: 0,
      human_override: false,
      bot_enabled: true,
      update: jest.fn().mockResolvedValue(undefined),
      lastMessage: ""
    };
    (Ticket.findOne as jest.Mock).mockResolvedValue(null);
    (Ticket.create as jest.Mock).mockResolvedValue(mockTicket);

    // No existing messages
    (Message.findByPk as jest.Mock).mockResolvedValue(null);
    (Message.findOne as jest.Mock).mockResolvedValue(null);
    (Message.create as jest.Mock).mockImplementation(async (data: any) => ({
      id: data.id || "msg-1",
      body: data.body,
      fromMe: data.fromMe
    }));
    (Message.findAll as jest.Mock).mockResolvedValue([]);

    // Tag mocks
    (Tag.findOrCreate as jest.Mock).mockResolvedValue([{ id: 1 }]);
    (ContactTag.findOne as jest.Mock).mockResolvedValue(null);
    (ContactTag.create as jest.Mock).mockResolvedValue({});

    // DB mocks
    let replayReserveCalls = 0;
    (sequelize.query as jest.Mock).mockImplementation(async (sql: string) => {
      const s = String(sql || "");
      if (s.includes("INSERT INTO ai_inbound_replay_guard")) {
        replayReserveCalls += 1;
        return replayReserveCalls === 1 ? [{ replay_key: "rk1" }] : [];
      }
      if (s.includes("INSERT INTO ai_decision_logs")) return [];
      if (s.includes("INSERT INTO ai_turns")) return [];
      if (s.includes("CREATE TABLE IF NOT EXISTS")) return [];
      if (s.includes("CREATE INDEX IF NOT EXISTS")) return [];
      if (s.includes("SELECT state_json FROM ai_ticket_state")) return [];
      if (s.includes("INSERT INTO ai_ticket_state")) return [];
      if (s.includes("UPDATE ai_ticket_state")) return [];
      if (s.includes("INSERT INTO ai_stage_events")) return [];
      if (s.includes("INSERT INTO ai_outbound_dedupe")) {
        return [{ dedupe_key: "dk1" }];
      }
      return [];
    });

    // Mock fetch for WhatsApp Cloud API sends
    fetchCalls = [];
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      fetchCalls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ messages: [{ id: `wamid.out.${fetchCalls.length}` }] })
      };
    });

    // Inbound: user sends message with complete search criteria
    const payload = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              id: "wamid.exactly-once-test",
              from: "5493411234567",
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: "text",
              text: { body: "Busco casa en Rosario, 3 ambientes, hasta 150000 USD. Mostrame opciones concretas." }
            }]
          }
        }]
      }]
    } as any;

    const result = await processCloudWebhookPayload(payload);

    // Message was processed
    expect(result.processed).toBe(1);
    expect(result.ignored).toBe(0);

    // Count outbound WhatsApp API calls (actual message sends)
    const whatsappSends = fetchCalls.filter(c =>
      String(c.url).includes("graph.facebook.com")
    );

    // CRITICAL ASSERTION: exactly 1 outbound message
    expect(whatsappSends.length).toBe(1);

    // The single reply should contain Tokko results, not fallback
    const sentBody = whatsappSends[0]?.body;
    const sentText = sentBody?.text?.body || "";
    expect(sentText).toContain("opciones concretas");
    expect(sentText).toContain("tokko.test");
    expect(sentText).not.toContain("No encontré opciones exactas");
  });
});
