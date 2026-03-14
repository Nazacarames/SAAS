import Whatsapp from "../../models/Whatsapp";
import Contact from "../../models/Contact";
import Message from "../../models/Message";
import crypto from "crypto";
import { Op } from "sequelize";
import AppError from "../../errors/AppError";
import { getIO } from "../../libs/socket";
import { getRuntimeSettings } from "../SettingsServices/RuntimeSettingsService";

interface SendOutboundTextRequest {
  companyId: number;
  whatsappId?: number;
  to: string;
  text: string;
  contactName?: string;
  idempotencyKey?: string;
}

const normalizeNumber = (raw: string): string => (raw || "").replace(/\D/g, "");
const normalizeIdempotencyKey = (raw: string): string => String(raw || "").trim().toLowerCase();
const IDEMPOTENCY_KEY_MAX_LENGTH = 120;
const IDEMPOTENCY_KEY_PATTERN = /^[a-z0-9:_\-.]+$/;
const DEFAULT_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const OUTBOUND_RETRY_DEDUP_WINDOW_MS = 90 * 1000;

const resolveOutboundRetryDedupWindowMs = (): number => {
  const settings = getRuntimeSettings() as any;
  const maxAttempts = Math.max(1, Math.min(6, Number(settings?.waOutboundRetryMaxAttempts || 3)));
  const timeoutMs = Math.max(1000, Math.min(45000, Math.round(Number(settings?.waOutboundRequestTimeoutMs || 12000))));
  const maxDelayMs = Math.max(500, Math.min(60000, Math.round(Number(settings?.waOutboundRetryMaxDelayMs || 15000))));

  // Keep duplicate window alive across complete retry budget (+ small post-send race buffer)
  const retryWindowMs = maxAttempts * timeoutMs + Math.max(0, maxAttempts - 1) * maxDelayMs;
  const safetyBufferMs = 15 * 1000;

  return Math.max(OUTBOUND_RETRY_DEDUP_WINDOW_MS, retryWindowMs + safetyBufferMs);
};

const resolveOutboundIdempotencyKeyMinLength = (): number => {
  const raw = Number((getRuntimeSettings() as any)?.waOutboundIdempotencyKeyMinLength);
  if (!Number.isFinite(raw)) return DEFAULT_IDEMPOTENCY_KEY_MIN_LENGTH;
  return Math.max(6, Math.min(64, Math.round(raw)));
};

const isTimestampOnlyIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return false;
  return /^\d{10,20}$/.test(normalized);
};

const isWeakIdempotencyKey = (key: string): boolean => {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return true;
  const distinctChars = new Set(normalized.split(""));
  return distinctChars.size < 2;
};

const outboundLocks = new Map<string, Promise<void>>();

const withOutboundLock = async <T>(lockKey: string, work: () => Promise<T>): Promise<T> => {
  const previous = outboundLocks.get(lockKey) || Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  outboundLocks.set(lockKey, chain);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (outboundLocks.get(lockKey) === chain) {
      outboundLocks.delete(lockKey);
    }
  }
};

const SendOutboundTextService = async ({ companyId, whatsappId, to, text, contactName, idempotencyKey }: SendOutboundTextRequest) => {
  const toNorm = normalizeNumber(to);
  if (!toNorm) throw new AppError("Invalid destination number", 400);

  const normalizedText = String(text || "").trim();
  if (!normalizedText) throw new AppError("Text is required", 400);


  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey || "");
  if (normalizedIdempotencyKey) {
    if (normalizedIdempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new AppError(`Invalid idempotency key (max ${IDEMPOTENCY_KEY_MAX_LENGTH} chars)`, 400);
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalizedIdempotencyKey)) {
      throw new AppError("Invalid idempotency key format", 400);
    }

    const minLen = resolveOutboundIdempotencyKeyMinLength();
    if (normalizedIdempotencyKey.length < minLen) {
      throw new AppError(`Invalid idempotency key (min ${minLen} chars)`, 400);
    }
    if (isTimestampOnlyIdempotencyKey(normalizedIdempotencyKey)) {
      throw new AppError("Invalid idempotency key (timestamp-only keys are blocked)", 400);
    }
    if (isWeakIdempotencyKey(normalizedIdempotencyKey)) {
      throw new AppError("Invalid idempotency key (too weak)", 400);
    }
  }

  const dedupFingerprint = normalizedIdempotencyKey
    ? `idemp:${normalizedIdempotencyKey}`
    : `body:${crypto
        .createHash("sha256")
        .update(`${companyId}|${toNorm}|${normalizedText}`)
        .digest("hex")
        .slice(0, 24)}`;

  const lockScope = normalizedIdempotencyKey
    ? `${companyId}:idemp:${normalizedIdempotencyKey}`
    : `${companyId}:${toNorm}:${dedupFingerprint}`;

  return withOutboundLock(lockScope, async () => {
    const wa = whatsappId
      ? await Whatsapp.findOne({ where: { id: whatsappId, companyId } })
      : await Whatsapp.findOne({ where: { companyId, isDefault: true } });

    if (!wa) throw new AppError("No WhatsApp connection available", 400);

    const settings = getRuntimeSettings() as any;
    const phoneNumberId = String(settings.waCloudPhoneNumberId || "").trim();
    const accessToken = String(settings.waCloudAccessToken || "").trim();
    if (!phoneNumberId || !accessToken) throw new AppError("WhatsApp Cloud credentials missing", 400);

    let contact = await Contact.findOne({ where: { companyId, number: toNorm } });
    if (!contact) {
      contact = await Contact.create({
        companyId,
        name: contactName || toNorm,
        number: toNorm,
        email: "",
        profilePicUrl: "",
        isGroup: false,
        whatsappId: wa.id
      });
    }

    const idempotencyProviderTag = normalizedIdempotencyKey ? `idemp:${normalizedIdempotencyKey}` : null;

    if (idempotencyProviderTag) {
      const existing = await Message.findOne({
        where: {
          fromMe: true,
          providerMessageId: idempotencyProviderTag
        },
        include: [
          {
            model: Contact,
            required: true,
            where: { companyId }
          }
        ],
        order: [["createdAt", "DESC"]]
      });

      if (existing) {
        const existingBody = String((existing as any).body || "").trim();
        const existingContact = (existing as any).contact as Contact | undefined;
        const existingTo = normalizeNumber(String(existingContact?.number || ""));

        if (existingBody !== normalizedText) {
          throw new AppError("Idempotency key reuse with different payload is blocked", 409);
        }

        if (existingTo && existingTo !== toNorm) {
          throw new AppError("Idempotency key reuse with different destination is blocked", 409);
        }

        return {
          conversationId: existingContact?.id || contact.id,
          contact: existingContact || contact,
          message: existing,
          idempotencyKey: normalizedIdempotencyKey,
          duplicate: true
        };
      }
    }

    const retryCutoff = new Date(Date.now() - resolveOutboundRetryDedupWindowMs());
    const recentDuplicate = await Message.findOne({
      where: {
        contactId: contact.id,
        fromMe: true,
        body: normalizedText,
        createdAt: {
          [Op.gte]: retryCutoff
        }
      },
      order: [["createdAt", "DESC"]]
    });

    if (recentDuplicate) {
      return {
        conversationId: contact.id,
        contact,
        message: recentDuplicate,
        idempotencyKey: normalizedIdempotencyKey || null,
        duplicate: true,
        dedupReason: "recent_retry_window"
      };
    }

    const cloudResp = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(idempotencyProviderTag ? { "Idempotency-Key": idempotencyProviderTag } : {})
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toNorm,
        type: "text",
        text: { body: normalizedText }
      })
    });
    const cloudJson: any = await cloudResp.json().catch(() => ({}));
    if (!cloudResp.ok) throw new AppError(cloudJson?.error?.message || `Cloud send failed (${cloudResp.status})`, 400);

    const msg = await Message.create({
      id: String(cloudJson?.messages?.[0]?.id || crypto.randomUUID()),
      body: normalizedText,
      contactId: contact.id,
      ticketId: null,
      fromMe: true,
      read: true,
      mediaType: "chat",
      providerMessageId: idempotencyProviderTag || null
    } as any);


    const io = getIO();
    const companyRoom = `company-${companyId}`;
    io.to(companyRoom).emit("newMessage", { action: "create", message: msg, contactId: contact.id, contact });
    io.to(companyRoom).emit("ticketUpdate", { action: "update" });

    return { conversationId: contact.id, contact, message: msg, idempotencyKey: normalizedIdempotencyKey || null };
  });
};

export default SendOutboundTextService;
