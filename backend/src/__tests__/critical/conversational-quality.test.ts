/**
 * Critical tests: conversational quality for 5 failing scenarios.
 *
 *   1. angry_client    → empathy + action, NOT generic greeting
 *   2. ambiguous       → NOT generic greeting when context exists
 *   3. switch_topic    → uses accumulated state, doesn't re-ask known criteria
 *   4. legal_sensitive → handoff to human
 *   5. visit_intent    → schedule visit CTA, NOT criteria template
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
let nextTicketId = 500;

const GENERIC_GREETING = "¡Hola! Soy el asistente";
const CRITERIA_TEMPLATE = "decime por favor zona, tipo, ambientes, presupuesto";

interface SetupOpts {
  /** Pre-existing state to return from ai_ticket_state (simulates conversation context) */
  existingState?: Record<string, any>;
}

const setupCommonMocks = (opts: SetupOpts = {}) => {
  const ticketId = nextTicketId++;
  const mockTicket = {
    id: ticketId, companyId: 1, status: "open", unreadMessages: 0,
    human_override: false, bot_enabled: true,
    update: jest.fn().mockResolvedValue(undefined), lastMessage: ""
  };

  // Orchestrator returns empty (forces fallback path through intent router)
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
    id: data.id || "msg-1", body: data.body, fromMe: data.fromMe
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
      return replayReserveCalls <= 10 ? [{ replay_key: `rk${replayReserveCalls}` }] : [];
    }
    if (s.includes("SELECT state_json FROM ai_ticket_state")) {
      if (opts.existingState) {
        return [{ state_json: JSON.stringify(opts.existingState) }];
      }
      return [];
    }
    if (s.includes("INSERT INTO ai_decision_logs")) return [];
    if (s.includes("INSERT INTO ai_turns")) return [];
    if (s.includes("CREATE TABLE IF NOT EXISTS")) return [];
    if (s.includes("CREATE INDEX IF NOT EXISTS")) return [];
    if (s.includes("INSERT INTO ai_ticket_state")) return [];
    if (s.includes("UPDATE ai_ticket_state")) return [];
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

  return { ticketId, mockTicket };
};

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

const buildPayload = (body: string, msgId?: string) => ({
  entry: [{
    changes: [{
      value: {
        messages: [{
          id: msgId || `wamid.cq-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("critical/conversational-quality", () => {

  // 1. angry_client: NOT generic greeting; YES empathy + action
  it("angry_client → empathy + action, NOT generic greeting", async () => {
    setupCommonMocks();

    await processCloudWebhookPayload(
      buildPayload("Estoy harto, nunca me responden, esto es un desastre. Ya van 3 veces que pregunto lo mismo.")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must contain empathy language
    expect(reply).toMatch(/disculp|molestia|entiendo/i);
    // Must NOT be generic greeting
    expect(reply).not.toContain(GENERIC_GREETING);
    // Must NOT be criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE);
  });

  // 2. ambiguous: NOT generic greeting when context already exists
  it("ambiguous message with existing context → NOT generic greeting", async () => {
    setupCommonMocks({
      existingState: {
        location: "Rosario",
        propertyType: "departamento",
        salesStage: "qualification"
      }
    });

    await processCloudWebhookPayload(
      buildPayload("y algo más chico?")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must NOT be generic greeting (context exists!)
    expect(reply).not.toContain(GENERIC_GREETING);
  });

  // 3. switch_topic: does NOT re-ask criteria already provided
  it("switch_topic with known criteria → does NOT re-ask already-provided fields", async () => {
    setupCommonMocks({
      existingState: {
        location: "Fisherton",
        propertyType: "casa",
        rooms: 3,
        salesStage: "qualification"
      }
    });

    await processCloudWebhookPayload(
      buildPayload("Ahora me interesa también algo en Funes, cambiemos la zona")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must NOT ask for fields already known (tipo, ambientes already in state)
    expect(reply).not.toMatch(/decime.*(tipo|ambientes)/i);
    // Must NOT be generic greeting
    expect(reply).not.toContain(GENERIC_GREETING);
  });

  // 4. legal_sensitive: handoff to human
  it("legal_sensitive → handoff to human agent", async () => {
    const { mockTicket } = setupCommonMocks();

    await processCloudWebhookPayload(
      buildPayload("Quiero hacer una demanda por incumplimiento del contrato de alquiler")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must mention human/asesor handoff
    expect(reply).toMatch(/asesor|humano|atenci[oó]n personalizada/i);
    // Ticket must be flagged for human override
    expect(mockTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ human_override: true, bot_enabled: false })
    );
    // Must NOT be generic greeting
    expect(reply).not.toContain(GENERIC_GREETING);
    // Must NOT be criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE);
  });

  // 5. visit_intent: schedule visit CTA, NOT criteria template
  it("visit_intent → coordinate visit response, NOT criteria template", async () => {
    setupCommonMocks({
      existingState: {
        location: "Rosario",
        propertyType: "departamento",
        rooms: 2,
        maxPriceUsd: 100000,
        salesStage: "qualification"
      }
    });

    await processCloudWebhookPayload(
      buildPayload("Quiero ir a ver el departamento, coordinemos una visita")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must mention visit scheduling
    expect(reply).toMatch(/visita|d[ií]a|franja|horario|coordin/i);
    // Must NOT be criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE);
    // Must NOT be generic greeting
    expect(reply).not.toContain(GENERIC_GREETING);
  });

  // 6. switch_topic with inline criteria: must NOT re-ask for ambientes/presupuesto
  it("switch_topic with inline criteria → does NOT re-ask ambientes or presupuesto", async () => {
    setupCommonMocks({
      existingState: {
        location: "Fisherton",
        propertyType: "casa",
        salesStage: "qualification"
      }
    });

    await processCloudWebhookPayload(
      buildPayload("ok, 2 ambientes hasta 90000 usd")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must NOT re-ask for ambientes (provided in message)
    expect(reply).not.toMatch(/ambientes/i);
    // Must NOT re-ask for presupuesto (provided in message)
    expect(reply).not.toMatch(/presupuesto/i);
    // Must NOT be generic criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE);
    // Must NOT be generic greeting
    expect(reply).not.toContain(GENERIC_GREETING);
  });

  // 7. 3-message switch_topic: zone_inquiry mid-flow, then criteria completion
  //    Simulates: 1) "Busco depto en centro" (state set), 2) "que zonas manejan?"
  //    (zone_inquiry), 3) "ok, 2 ambientes hasta 90000 usd" (completes criteria).
  //    Step 3 must NOT re-ask for ambientes or presupuesto, must NOT send fallback.
  it("3-step switch_topic: criteria in last turn → no re-ask, no conflicting fallback", async () => {
    // After steps 1+2, accumulated state has location+propertyType from step 1
    // and zone_inquiry outcome from step 2.  Step 3 provides rooms+budget.
    setupCommonMocks({
      existingState: {
        location: "centro",
        propertyType: "departamento",
        salesStage: "qualification",
        lastOutcome: "intent_zone_inquiry"
      }
    });

    await processCloudWebhookPayload(
      buildPayload("ok, 2 ambientes hasta 90000 usd")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must NOT mention "me falta saber" for criteria just provided
    expect(reply).not.toMatch(/falta\s+saber.*ambientes/i);
    expect(reply).not.toMatch(/falta\s+saber.*presupuesto/i);
    // Must NOT re-ask any criteria already provided in this turn or prior
    expect(reply).not.toMatch(/decime.*ambientes/i);
    expect(reply).not.toMatch(/decime.*presupuesto/i);
    // Must NOT be generic greeting
    expect(reply).not.toContain(GENERIC_GREETING);
    // Must NOT be criteria template
    expect(reply).not.toContain(CRITERIA_TEMPLATE);
    // Should get a coherent response (Tokko results, "no encontré" with adjust, or orchestrator reply)
    expect(reply.length).toBeGreaterThan(10);
  });

  // 8. Orchestrator-generated criteria re-ask is stripped when current turn provides values
  it("orchestrator reply asking for ambientes → stripped when user already provided them", async () => {
    const { mockTicket } = setupCommonMocks({
      existingState: {
        location: "centro",
        propertyType: "departamento",
        salesStage: "qualification"
      }
    });

    // Orchestrator returns a reply that is ENTIRELY a criteria re-ask
    (generateConversationalReply as jest.Mock).mockResolvedValue({
      reply: "Decime cuántos ambientes necesitás y qué presupuesto tenés.",
      model: "gpt-4o-mini",
      usedFallback: false,
      toolCallCount: 0,
      knowledge: [],
      tokko: { used: false, results: 0 }
    });

    await processCloudWebhookPayload(
      buildPayload("ok, 2 ambientes hasta 90000 usd")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // The redundant criteria ask should have been stripped — must NOT echo back the bad text
    expect(reply).not.toMatch(/cu[aá]ntos?\s+ambientes/i);
    expect(reply).not.toMatch(/presupuesto/i);
    // Should get a safe generic acknowledgement instead
    expect(reply.length).toBeGreaterThan(10);
  });

  // 9. Orchestrator reply with mixed content: useful part kept, criteria ask stripped
  it("orchestrator reply with mixed useful + criteria re-ask → keeps useful part", async () => {
    setupCommonMocks({
      existingState: {
        location: "centro",
        propertyType: "departamento",
        salesStage: "qualification"
      }
    });

    (generateConversationalReply as jest.Mock).mockResolvedValue({
      reply: "Tengo varias opciones en centro que te pueden interesar. Necesito que me pases cuántos ambientes buscás y tu presupuesto.",
      model: "gpt-4o-mini",
      usedFallback: false,
      toolCallCount: 0,
      knowledge: [],
      tokko: { used: false, results: 0 }
    });

    await processCloudWebhookPayload(
      buildPayload("ok, 2 ambientes hasta 90000 usd")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // Must keep the useful part
    expect(reply).toMatch(/opciones en centro/i);
    // Must strip the criteria re-ask
    expect(reply).not.toMatch(/cu[aá]ntos?\s+ambientes/i);
    expect(reply).not.toMatch(/presupuesto/i);
  });

  // 10. EXACT production bug (ticket 131): orchestrator returns "me falta saber:
  //     ambientes y presupuesto" when user just provided both in "ok, 2 ambientes
  //     hasta 90000 usd".  Hard guard must block this even if strip regex fails.
  it("production bug: 'me falta saber: ambientes y presupuesto' blocked when turn has both", async () => {
    setupCommonMocks({
      existingState: {
        location: "centro",
        propertyType: "departamento",
        salesStage: "qualification",
        lastOutcome: "intent_zone_inquiry"
      }
    });

    // Orchestrator returns the EXACT production-observed bad text
    (generateConversationalReply as jest.Mock).mockResolvedValue({
      reply: "Para buscarte opciones concretas, me falta saber: ambientes y presupuesto. Con eso te paso propiedades ahora mismo.",
      model: "gpt-4o-mini",
      usedFallback: false,
      toolCallCount: 0,
      knowledge: [],
      tokko: { used: false, results: 0 }
    });

    await processCloudWebhookPayload(
      buildPayload("ok, 2 ambientes hasta 90000 usd")
    );

    const sent = getSentTexts();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const reply = sent.join("\n");

    // The EXACT production bad text must be blocked
    expect(reply).not.toMatch(/me falta saber.*ambientes/i);
    expect(reply).not.toMatch(/me falta saber.*presupuesto/i);
    expect(reply).not.toMatch(/falta saber: ambientes y presupuesto/i);
    // Must NOT echo the bad text back verbatim
    expect(reply).not.toContain("ambientes y presupuesto");
    // Must get a safe response instead
    expect(reply.length).toBeGreaterThan(10);
  });
});
