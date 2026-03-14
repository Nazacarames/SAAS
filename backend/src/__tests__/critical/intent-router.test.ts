/**
 * Critical tests: intent router prevents generic criteria template from
 * firing on non-property-search intents.
 *
 * Scenarios:
 *   1. "quiero vender y comprar"  → sell_and_buy reply, NOT criteria template
 *   2. "qué zonas tienen?"        → zone inquiry reply, NOT criteria template
 *   3. "hola" / "que?"            → conversational reply, NOT criteria template
 *   4. property search with criteria → Tokko options (1 per message)
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

// ── shared helpers ─────────────────────────────────────────────────────

let fetchCalls: Array<{ url: string; body: any }> = [];
const originalFetch = globalThis.fetch;
const CRITERIA_TEMPLATE_FRAGMENT = "decime por favor zona, tipo, ambientes, presupuesto";

// Use unique ticket IDs per test to avoid module-level autoReplyTicketLock
// (45s in-memory lock) persisting across tests.
let nextTicketId = 100;

const setupCommonMocks = () => {
  const ticketId = nextTicketId++;

  // Orchestrator returns empty (forces fallback path)
  (generateConversationalReply as jest.Mock).mockResolvedValue({
    reply: "",
    model: "gpt-4o-mini",
    usedFallback: true,
    toolCallCount: 0,
    knowledge: [],
    tokko: { used: false, results: 0 }
  });

  // Tokko returns nothing by default (override per test if needed)
  (searchTokkoProperties as jest.Mock).mockResolvedValue({ results: [] });

  // Whatsapp connection
  (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 10, companyId: 1 });

  // Contact
  (Contact.findOne as jest.Mock).mockResolvedValue(null);
  (Contact.create as jest.Mock).mockResolvedValue({
    id: 20, number: "5493411234567", update: jest.fn().mockResolvedValue(undefined)
  });

  // Ticket — unique ID per test to avoid cross-test lock collisions
  (Ticket.findOne as jest.Mock).mockResolvedValue(null);
  (Ticket.create as jest.Mock).mockResolvedValue({
    id: ticketId, companyId: 1, status: "open", unreadMessages: 0,
    human_override: false, bot_enabled: true,
    update: jest.fn().mockResolvedValue(undefined), lastMessage: ""
  });

  // Messages
  (Message.findByPk as jest.Mock).mockResolvedValue(null);
  (Message.findOne as jest.Mock).mockResolvedValue(null);
  (Message.create as jest.Mock).mockImplementation(async (data: any) => ({
    id: data.id || "msg-1", body: data.body, fromMe: data.fromMe
  }));
  (Message.findAll as jest.Mock).mockResolvedValue([]);

  // Tags
  (Tag.findOrCreate as jest.Mock).mockResolvedValue([{ id: 1 }]);
  (ContactTag.findOne as jest.Mock).mockResolvedValue(null);
  (ContactTag.create as jest.Mock).mockResolvedValue({});

  // DB queries
  let replayReserveCalls = 0;
  (sequelize.query as jest.Mock).mockImplementation(async (sql: string) => {
    const s = String(sql || "");
    if (s.includes("INSERT INTO ai_inbound_replay_guard")) {
      replayReserveCalls += 1;
      return replayReserveCalls <= 10 ? [{ replay_key: `rk${replayReserveCalls}` }] : [];
    }
    if (s.includes("INSERT INTO ai_decision_logs")) return [];
    if (s.includes("INSERT INTO ai_turns")) return [];
    if (s.includes("CREATE TABLE IF NOT EXISTS")) return [];
    if (s.includes("CREATE INDEX IF NOT EXISTS")) return [];
    if (s.includes("SELECT state_json FROM ai_ticket_state")) return [];
    if (s.includes("INSERT INTO ai_ticket_state")) return [];
    if (s.includes("UPDATE ai_ticket_state")) return [];
    if (s.includes("INSERT INTO ai_stage_events")) return [];
    if (s.includes("INSERT INTO ai_outbound_dedupe")) return [{ dedupe_key: "dk1" }];
    return [];
  });

  // Fetch mock
  fetchCalls = [];
  (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    fetchCalls.push({ url, body });
    return {
      ok: true,
      json: async () => ({ messages: [{ id: `wamid.out.${fetchCalls.length}` }] })
    };
  });
};

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

const buildPayload = (body: string, msgId?: string) => ({
  entry: [{
    changes: [{
      value: {
        messages: [{
          id: msgId || `wamid.test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          from: "5493411234567",
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "text",
          text: { body }
        }]
      }
    }]
  }]
} as any);

const getSentTexts = (): string[] =>
  fetchCalls
    .filter(c => String(c.url).includes("graph.facebook.com"))
    .map(c => String(c.body?.text?.body || ""));

// ── tests ──────────────────────────────────────────────────────────────

describe("critical/intent-router", () => {

  it('"quiero vender y comprar" → sell_and_buy reply, NOT criteria template', async () => {
    setupCommonMocks();

    const result = await processCloudWebhookPayload(
      buildPayload("Quiero vender mi casa y comprar otra más grande")
    );

    expect(result.processed).toBe(1);
    const sent = getSentTexts();
    expect(sent.length).toBe(1);

    const reply = sent[0];
    // Should mention both sell and buy
    expect(reply).toMatch(/venta.*compra|compra.*venta|vender.*comprar/i);
    // Must NOT contain the generic criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE_FRAGMENT);
    expect(reply).not.toMatch(/decime por favor.*zona.*tipo.*ambientes.*presupuesto/i);
  });

  it('"qué zonas tienen?" → zone reply, NOT criteria template', async () => {
    setupCommonMocks();

    const result = await processCloudWebhookPayload(
      buildPayload("Qué zonas tienen disponibles?")
    );

    expect(result.processed).toBe(1);
    const sent = getSentTexts();
    expect(sent.length).toBe(1);

    const reply = sent[0];
    // Should mention actual zones
    expect(reply).toMatch(/rosario|centro|fisherton|pichincha|funes/i);
    // Must NOT contain the generic criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE_FRAGMENT);
    expect(reply).not.toMatch(/decime por favor.*zona.*tipo.*ambientes.*presupuesto/i);
  });

  it('"hola" → conversational reply, NOT criteria template', async () => {
    setupCommonMocks();

    const result = await processCloudWebhookPayload(
      buildPayload("hola, buenas tardes")
    );

    expect(result.processed).toBe(1);
    const sent = getSentTexts();
    expect(sent.length).toBe(1);

    const reply = sent[0];
    // Should be a friendly greeting
    expect(reply).toMatch(/hola|ayud|asistente/i);
    // Must NOT contain the generic criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE_FRAGMENT);
    expect(reply).not.toMatch(/decime por favor.*zona.*tipo.*ambientes.*presupuesto/i);
  });

  it('"que?" → conversational reply, NOT criteria template', async () => {
    setupCommonMocks();

    const result = await processCloudWebhookPayload(
      buildPayload("que?", "wamid.test-que")
    );

    expect(result.processed).toBe(1);
    const sent = getSentTexts();
    expect(sent.length).toBe(1);

    const reply = sent[0];
    // Must NOT contain the generic criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE_FRAGMENT);
    expect(reply).not.toMatch(/decime por favor.*zona.*tipo.*ambientes.*presupuesto/i);
  });

  it("property search con criterios → Tokko options, no criteria template", async () => {
    setupCommonMocks();

    // Tokko returns results for this test
    (searchTokkoProperties as jest.Mock).mockResolvedValue({
      results: [
        { title: "Casa en Rosario", location: "Rosario Centro", price: 120000, rooms: 3, url: "https://tokko.test/1" },
        { title: "Depto en Fisherton", location: "Fisherton", price: 95000, rooms: 2, url: "https://tokko.test/2" }
      ]
    });

    const result = await processCloudWebhookPayload(
      buildPayload("Busco casa en Rosario, 3 ambientes, hasta 150000 USD. Mostrame opciones.")
    );

    expect(result.processed).toBe(1);
    const sent = getSentTexts();

    // Should have Tokko results (could be 1 combined or multiple per-property)
    expect(sent.length).toBeGreaterThanOrEqual(1);

    const allText = sent.join("\n");
    // Should contain property info
    expect(allText).toMatch(/tokko\.test|Casa en Rosario|opciones concretas/i);
    // Must NOT contain the generic criteria template
    expect(allText).not.toContain(CRITERIA_TEMPLATE_FRAGMENT);
    expect(allText).not.toMatch(/No encontré opciones exactas/i);
  });
});
