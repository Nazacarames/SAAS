/**
 * Critical test: switch_topic race condition.
 *
 * Simulates 3 messages from the same ticket arriving in rapid succession
 * (separate webhook payloads, processed concurrently).  The per-ticket
 * turn queue must serialise them so that turn 3 always sees the state
 * saved by turns 1 and 2, and never emits a stale "me falta saber:
 * ambientes y presupuesto" fallback.
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

let fetchCalls: Array<{ url: string; body: any }> = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

const buildPayload = (body: string, msgId?: string) => ({
  entry: [{
    changes: [{
      value: {
        messages: [{
          id: msgId || `wamid.race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("critical/switch-topic-race", () => {

  // Exact production flow: 3 messages arrive as separate webhook payloads,
  // potentially concurrently.  The queue must serialise them.
  it("3-turn concurrent flow: turn 3 never sends stale criteria fallback", async () => {
    const ticketId = 900;
    let msgCounter = 0;

    // Simulate mutable state that accumulates across turns
    let savedState: Record<string, any> = {};

    const mockTicket = {
      id: ticketId, companyId: 1, status: "open", unreadMessages: 0,
      human_override: false, bot_enabled: true,
      update: jest.fn().mockResolvedValue(undefined), lastMessage: ""
    };

    (generateConversationalReply as jest.Mock).mockResolvedValue({
      reply: "", model: "gpt-4o-mini", usedFallback: true,
      toolCallCount: 0, knowledge: [], tokko: { used: false, results: 0 }
    });
    (searchTokkoProperties as jest.Mock).mockResolvedValue({ results: [] });

    (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 10, companyId: 1 });
    (Contact.findOne as jest.Mock).mockResolvedValue(null);
    (Contact.create as jest.Mock).mockResolvedValue({
      id: 20, number: "5493411234567", update: jest.fn().mockResolvedValue(undefined)
    });
    (Ticket.findOne as jest.Mock).mockResolvedValue(null);
    (Ticket.create as jest.Mock).mockResolvedValue(mockTicket);
    (Message.findByPk as jest.Mock).mockResolvedValue(null);
    (Message.findOne as jest.Mock).mockResolvedValue(null);
    (Message.create as jest.Mock).mockImplementation(async (data: any) => ({
      id: data.id || `msg-${++msgCounter}`, body: data.body, fromMe: data.fromMe
    }));
    (Message.findAll as jest.Mock).mockResolvedValue([]);
    (Tag.findOrCreate as jest.Mock).mockResolvedValue([{ id: 1 }]);
    (ContactTag.findOne as jest.Mock).mockResolvedValue(null);
    (ContactTag.create as jest.Mock).mockResolvedValue({});

    let replayReserveCalls = 0;
    (sequelize.query as jest.Mock).mockImplementation(async (sql: string) => {
      const s = String(sql || "");
      if (s.includes("INSERT INTO ai_inbound_replay_guard")) {
        replayReserveCalls += 1;
        return replayReserveCalls <= 20 ? [{ replay_key: `rk${replayReserveCalls}` }] : [];
      }
      // Return ACCUMULATED state — simulates real DB that persists across turns
      if (s.includes("SELECT state_json FROM ai_ticket_state")) {
        return Object.keys(savedState).length > 0
          ? [{ state_json: JSON.stringify(savedState) }]
          : [];
      }
      // Capture state saves to simulate persistence
      if (s.includes("INSERT INTO ai_ticket_state") || s.includes("UPDATE ai_ticket_state")) {
        const match = String(s).match(/:stateJson/);
        // Extract stateJson from replacements via the mock call args
        const callArgs = (sequelize.query as jest.Mock).mock.calls;
        const lastCall = callArgs[callArgs.length - 1];
        if (lastCall?.[1]?.replacements?.stateJson) {
          try {
            const newState = JSON.parse(lastCall[1].replacements.stateJson);
            savedState = { ...savedState, ...newState };
          } catch {}
        }
        return [];
      }
      if (s.includes("INSERT INTO ai_decision_logs")) return [];
      if (s.includes("INSERT INTO ai_turns")) return [];
      if (s.includes("CREATE TABLE IF NOT EXISTS")) return [];
      if (s.includes("CREATE INDEX IF NOT EXISTS")) return [];
      if (s.includes("INSERT INTO ai_stage_events")) return [];
      if (s.includes("INSERT INTO ai_outbound_dedupe")) return [{ dedupe_key: "dk1" }];
      return [];
    });

    fetchCalls = [];
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      fetchCalls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ messages: [{ id: `wamid.out.${fetchCalls.length}` }] })
      };
    });

    // Fire 3 webhook payloads concurrently (simulates real production race)
    await Promise.all([
      processCloudWebhookPayload(buildPayload("Busco depto en centro", "wamid.turn1")),
      processCloudWebhookPayload(buildPayload("antes, que zonas manejan?", "wamid.turn2")),
      processCloudWebhookPayload(buildPayload("ok, 2 ambientes hasta 90000 usd", "wamid.turn3"))
    ]);

    const allSent = getSentTexts();

    // At least one reply per turn expected (queue serialises, each gets a reply)
    expect(allSent.length).toBeGreaterThanOrEqual(2);

    // Turn 1 MAY legitimately ask for ambientes/presupuesto (only has location+type).
    // But the LAST reply (turn 3, which provides rooms+budget) must NEVER re-ask.
    const lastReply = allSent[allSent.length - 1];
    expect(lastReply).not.toMatch(/me falta saber.*ambientes/i);
    expect(lastReply).not.toMatch(/me falta saber.*presupuesto/i);
    expect(lastReply).not.toMatch(/falta saber: ambientes y presupuesto/i);
  }, 30000);

  // Sequential (same-payload) variant: messages in one webhook payload
  it("3-turn same-payload flow: messages process in order, no stale fallback", async () => {
    const ticketId = 901;
    let msgCounter = 0;
    let savedState: Record<string, any> = {};

    const mockTicket = {
      id: ticketId, companyId: 1, status: "open", unreadMessages: 0,
      human_override: false, bot_enabled: true,
      update: jest.fn().mockResolvedValue(undefined), lastMessage: ""
    };

    (generateConversationalReply as jest.Mock).mockResolvedValue({
      reply: "", model: "gpt-4o-mini", usedFallback: true,
      toolCallCount: 0, knowledge: [], tokko: { used: false, results: 0 }
    });
    (searchTokkoProperties as jest.Mock).mockResolvedValue({ results: [] });

    (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 10, companyId: 1 });
    (Contact.findOne as jest.Mock).mockResolvedValue(null);
    (Contact.create as jest.Mock).mockResolvedValue({
      id: 21, number: "5493411234567", update: jest.fn().mockResolvedValue(undefined)
    });
    (Ticket.findOne as jest.Mock).mockResolvedValue(null);
    (Ticket.create as jest.Mock).mockResolvedValue(mockTicket);
    (Message.findByPk as jest.Mock).mockResolvedValue(null);
    (Message.findOne as jest.Mock).mockResolvedValue(null);
    (Message.create as jest.Mock).mockImplementation(async (data: any) => ({
      id: data.id || `msg-${++msgCounter}`, body: data.body, fromMe: data.fromMe
    }));
    (Message.findAll as jest.Mock).mockResolvedValue([]);
    (Tag.findOrCreate as jest.Mock).mockResolvedValue([{ id: 1 }]);
    (ContactTag.findOne as jest.Mock).mockResolvedValue(null);
    (ContactTag.create as jest.Mock).mockResolvedValue({});

    let replayReserveCalls = 0;
    (sequelize.query as jest.Mock).mockImplementation(async (sql: string) => {
      const s = String(sql || "");
      if (s.includes("INSERT INTO ai_inbound_replay_guard")) {
        replayReserveCalls += 1;
        return replayReserveCalls <= 20 ? [{ replay_key: `rk${replayReserveCalls}` }] : [];
      }
      if (s.includes("SELECT state_json FROM ai_ticket_state")) {
        return Object.keys(savedState).length > 0
          ? [{ state_json: JSON.stringify(savedState) }]
          : [];
      }
      if (s.includes("INSERT INTO ai_ticket_state") || s.includes("UPDATE ai_ticket_state")) {
        const callArgs = (sequelize.query as jest.Mock).mock.calls;
        const lastCall = callArgs[callArgs.length - 1];
        if (lastCall?.[1]?.replacements?.stateJson) {
          try {
            const newState = JSON.parse(lastCall[1].replacements.stateJson);
            savedState = { ...savedState, ...newState };
          } catch {}
        }
        return [];
      }
      if (s.includes("INSERT INTO ai_decision_logs")) return [];
      if (s.includes("INSERT INTO ai_turns")) return [];
      if (s.includes("CREATE TABLE IF NOT EXISTS")) return [];
      if (s.includes("CREATE INDEX IF NOT EXISTS")) return [];
      if (s.includes("INSERT INTO ai_stage_events")) return [];
      if (s.includes("INSERT INTO ai_outbound_dedupe")) return [{ dedupe_key: "dk1" }];
      return [];
    });

    fetchCalls = [];
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      fetchCalls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ messages: [{ id: `wamid.out.${fetchCalls.length}` }] })
      };
    });

    // Single payload with 3 messages (processed sequentially within payload)
    const multiPayload = {
      entry: [{
        changes: [{
          value: {
            messages: [
              { id: "wamid.seq1", from: "5493411234567", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Busco depto en centro" } },
              { id: "wamid.seq2", from: "5493411234567", timestamp: String(Math.floor(Date.now() / 1000) + 1), type: "text", text: { body: "antes, que zonas manejan?" } },
              { id: "wamid.seq3", from: "5493411234567", timestamp: String(Math.floor(Date.now() / 1000) + 2), type: "text", text: { body: "ok, 2 ambientes hasta 90000 usd" } }
            ]
          }
        }]
      }]
    } as any;

    await processCloudWebhookPayload(multiPayload);

    const allSent = getSentTexts();

    // Should have replies for each turn
    expect(allSent.length).toBeGreaterThanOrEqual(2);

    // The LAST reply (for turn 3, which provides rooms+budget) must NOT re-ask
    const lastReply = allSent[allSent.length - 1];
    expect(lastReply).not.toMatch(/me falta saber.*ambientes/i);
    expect(lastReply).not.toMatch(/me falta saber.*presupuesto/i);
    expect(lastReply).not.toMatch(/falta saber: ambientes y presupuesto/i);

    // State should have accumulated criteria from all 3 turns
    expect(savedState.location).toBe("centro");
    expect(savedState.rooms).toBe(2);
    expect(savedState.maxPriceUsd).toBe(90000);
  }, 30000);
});
