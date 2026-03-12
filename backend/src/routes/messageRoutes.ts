import { Router } from "express";
import isAuth from "../middleware/isAuth";
import SendMessageService from "../services/MessageServices/SendMessageService";
import ListMessagesService from "../services/MessageServices/ListMessagesService";
import { getRuntimeSettings } from "../services/SettingsServices/RuntimeSettingsService";

const messageRoutes = Router();

const IDEMPOTENCY_KEY_MAX_LENGTH = 120;
const RETRY_ATTEMPT_VALID_MAX = 1000;

const resolveOutboundRetryAttemptMaxAccepted = (): number => {
  const raw = Number((getRuntimeSettings() as any)?.waOutboundRetryAttemptMaxAccepted);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(2, Math.min(100, Math.round(raw)));
};

const normalizeIdempotencyKey = (raw: string): string => {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_\-.]/g, "")
    .slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
};

const hasInvalidIdempotencyChars = (raw: string): boolean => /[^a-zA-Z0-9:_\-.]/.test(String(raw || "").trim());

const resolveRetryAttempt = (req: any): { retryAttempt: number | null; invalidRaw: string | null } => {
  const bodyRaw = (req?.body as any)?.retryAttempt;
  const headerRaw = req.get("x-retry-attempt") || req.get("x-retry-count") || "";
  const raw = String(bodyRaw ?? headerRaw ?? "").trim();
  if (!raw) return { retryAttempt: null, invalidRaw: null };
  if (!/^\d+$/.test(raw)) return { retryAttempt: null, invalidRaw: raw };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > RETRY_ATTEMPT_VALID_MAX) {
    return { retryAttempt: null, invalidRaw: raw };
  }
  return { retryAttempt: parsed, invalidRaw: null };
};

// List messages for a conversation (contact-based)
messageRoutes.get("/:conversationId", isAuth, async (req: any, res) => {
  const { conversationId } = req.params;
  const contactId = parseInt(conversationId);
  const messages: any[] = await (ListMessagesService as any)({ contactId });
  return res.json(messages);
});

// Send message to conversation contact via WhatsApp
messageRoutes.post("/", isAuth, async (req: any, res) => {
  const { body, conversationId, contactId, idempotencyKey } = req.body;
  const idempotencyHeaderXRaw = String(req.headers?.["x-idempotency-key"] || "").trim();
  const idempotencyHeaderStdRaw = String(req.headers?.["idempotency-key"] || "").trim();
  const idempotencyBodyRaw = String(idempotencyKey || "").trim();

  if (idempotencyHeaderXRaw && idempotencyHeaderXRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ error: `x-idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }
  if (idempotencyHeaderStdRaw && idempotencyHeaderStdRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ error: `idempotency-key too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }
  if (idempotencyBodyRaw && idempotencyBodyRaw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return res.status(400).json({ error: `body.idempotencyKey too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})` });
  }

  if (idempotencyHeaderXRaw && hasInvalidIdempotencyChars(idempotencyHeaderXRaw)) {
    return res.status(400).json({ error: "x-idempotency-key contains invalid characters" });
  }
  if (idempotencyHeaderStdRaw && hasInvalidIdempotencyChars(idempotencyHeaderStdRaw)) {
    return res.status(400).json({ error: "idempotency-key contains invalid characters" });
  }
  if (idempotencyBodyRaw && hasInvalidIdempotencyChars(idempotencyBodyRaw)) {
    return res.status(400).json({ error: "body.idempotencyKey contains invalid characters" });
  }

  const idempotencyHeaderX = normalizeIdempotencyKey(idempotencyHeaderXRaw);
  const idempotencyHeaderStd = normalizeIdempotencyKey(idempotencyHeaderStdRaw);
  const idempotencyBody = normalizeIdempotencyKey(idempotencyBodyRaw);

  if (idempotencyHeaderX && idempotencyHeaderStd && idempotencyHeaderX !== idempotencyHeaderStd) {
    return res.status(400).json({ error: "idempotency key mismatch between x-idempotency-key and idempotency-key headers" });
  }

  const effectiveHeaderKey = idempotencyHeaderX || idempotencyHeaderStd;
  if (effectiveHeaderKey && idempotencyBody && effectiveHeaderKey !== idempotencyBody) {
    return res.status(400).json({ error: "idempotency key mismatch between header and body" });
  }

  const effectiveIdempotencyKey = effectiveHeaderKey || idempotencyBody;
  const { id: userId } = req.user;

  const settings = getRuntimeSettings();
  const retryAttemptResolution = resolveRetryAttempt(req);
  const retryAttempt = retryAttemptResolution.retryAttempt;
  const isExplicitRetry = retryAttempt !== null && retryAttempt > 1;

  if (retryAttemptResolution.invalidRaw) {
    return res.status(400).json({
      error: `retryAttempt invalid (allowed integer range: 1..${RETRY_ATTEMPT_VALID_MAX})`,
      retryAttempt: retryAttemptResolution.invalidRaw
    });
  }

  const retryAttemptMaxAccepted = resolveOutboundRetryAttemptMaxAccepted();
  if (retryAttempt !== null && retryAttempt > retryAttemptMaxAccepted) {
    return res.status(400).json({
      error: `retryAttempt too high (max ${retryAttemptMaxAccepted})`,
      retryAttempt,
      retryAttemptMaxAccepted
    });
  }

  const retryRequiresIdempotency = Boolean(settings?.waOutboundRetryRequireIdempotencyKey);
  if ((retryRequiresIdempotency || isExplicitRetry) && !effectiveIdempotencyKey) {
    return res.status(400).json({
      error: isExplicitRetry
        ? "x-idempotency-key (or body.idempotencyKey) is required for safe retries (retryAttempt > 1)"
        : "x-idempotency-key (or body.idempotencyKey) is required"
    });
  }

  const message = await SendMessageService({
    body,
    contactId: Number(contactId || conversationId),
    userId,
    idempotencyKey: effectiveIdempotencyKey || undefined
  });

  return res.status(201).json(message);
});

export default messageRoutes;
