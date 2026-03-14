/**
 * Chatwoot API Client
 *
 * Sends text messages and media (photo URLs) to Chatwoot conversations.
 * Handles multi-part responses by splitting AI output into property blocks + photos.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatwootConfig {
  apiUrl: string;     // e.g. "https://app.chatwoot.com"
  accountId: string;  // Chatwoot account ID
  apiToken: string;   // api_access_token
}

interface SendTextResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/** A parsed segment of the AI response: either a text block or a photo URL */
export interface ResponseSegment {
  type: "text" | "photo";
  content: string; // text body or image URL
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export const getChatwootConfig = (): ChatwootConfig | null => {
  const apiUrl = (process.env.CHATWOOT_API_URL || "").replace(/\/$/, "");
  const accountId = process.env.CHATWOOT_ACCOUNT_ID || "";
  const apiToken = process.env.CHATWOOT_API_TOKEN || "";
  if (!apiUrl || !accountId || !apiToken) return null;
  return { apiUrl, accountId, apiToken };
};

// ---------------------------------------------------------------------------
// Send text message
// ---------------------------------------------------------------------------

export const sendChatwootTextMessage = async (
  conversationId: number | string,
  content: string,
  config?: ChatwootConfig | null
): Promise<SendTextResult> => {
  const cfg = config || getChatwootConfig();
  if (!cfg) return { ok: false, error: "missing_chatwoot_config" };

  const cleanContent = String(content || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!cleanContent) return { ok: false, error: "empty_content" };

  const url = `${cfg.apiUrl}/api/v1/accounts/${cfg.accountId}/conversations/${conversationId}/messages`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          api_access_token: cfg.apiToken,
        },
        body: JSON.stringify({
          content: cleanContent,
          message_type: "outgoing",
          private: false,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (res.ok) {
        const data: any = await res.json().catch(() => ({}));
        return { ok: true, messageId: data?.id };
      }

      // Non-retryable client errors
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        console.error("[chatwoot][send] client error", { status: res.status, body: body.slice(0, 300) });
        return { ok: false, error: `status_${res.status}` };
      }

      // Server error — retry
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }

      return { ok: false, error: `status_${res.status}` };
    } catch (e: any) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      console.error("[chatwoot][send] exception:", e?.message || e);
      return { ok: false, error: e?.message || "network_error" };
    }
  }

  return { ok: false, error: "exhausted_retries" };
};

// ---------------------------------------------------------------------------
// Send media (photo URL) message
// ---------------------------------------------------------------------------

export const sendChatwootMediaMessage = async (
  conversationId: number | string,
  imageUrl: string,
  caption?: string,
  config?: ChatwootConfig | null
): Promise<SendTextResult> => {
  const cfg = config || getChatwootConfig();
  if (!cfg) return { ok: false, error: "missing_chatwoot_config" };

  const url = `${cfg.apiUrl}/api/v1/accounts/${cfg.accountId}/conversations/${conversationId}/messages`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    // Chatwoot accepts content_attributes.external_media_url for remote images
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        api_access_token: cfg.apiToken,
      },
      body: JSON.stringify({
        content: caption || "",
        message_type: "outgoing",
        private: false,
        content_attributes: {
          external_media_url: imageUrl,
        },
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      return { ok: true, messageId: data?.id };
    }

    const body = await res.text().catch(() => "");
    console.error("[chatwoot][media] error", { status: res.status, body: body.slice(0, 300) });
    return { ok: false, error: `status_${res.status}` };
  } catch (e: any) {
    console.error("[chatwoot][media] exception:", e?.message || e);
    return { ok: false, error: e?.message || "network_error" };
  }
};

// ---------------------------------------------------------------------------
// Parse AI response into segments (replaces n8n Format Chain)
// ---------------------------------------------------------------------------

/**
 * Parses the AI agent's text response into segments for multi-part delivery.
 *
 * Detects property blocks by looking for "🔗 Ver ficha" or "🖼 Foto principal:" markers.
 * Extracts photo URLs and strips them from text blocks.
 *
 * For plain conversational messages, returns a single text segment.
 */
export const parseResponseSegments = (text: string): ResponseSegment[] => {
  const clean = String(text || "").trim();
  if (!clean) return [];

  // Check if this looks like a property listing response
  const hasPropertyMarkers = /🔗\s*Ver ficha|🖼\s*Foto principal:/i.test(clean);
  if (!hasPropertyMarkers) {
    return [{ type: "text", content: clean }];
  }

  const segments: ResponseSegment[] = [];

  // Split on property blocks. Each property typically starts with an emoji + bold title
  // or has a blank line separator between blocks.
  // Strategy: split on double newlines, then group intro/properties/closing.
  const blocks = clean.split(/\n{2,}/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Extract photo URL from "🖼 Foto principal: <URL>" lines
    const photoMatch = trimmed.match(/🖼\s*Foto principal:\s*(https?:\/\/\S+)/i);
    const photoUrl = photoMatch?.[1] || "";

    // Remove the photo line from the text block
    const textWithoutPhoto = trimmed
      .replace(/🖼\s*Foto principal:\s*\S*/gi, "")
      .trim();

    if (textWithoutPhoto) {
      segments.push({ type: "text", content: textWithoutPhoto });
    }

    if (photoUrl && /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)/i.test(photoUrl)) {
      segments.push({ type: "photo", content: photoUrl });
    }
  }

  return segments.length > 0 ? segments : [{ type: "text", content: clean }];
};

// ---------------------------------------------------------------------------
// Send full AI response (multi-part)
// ---------------------------------------------------------------------------

/**
 * Sends the AI agent's response to a Chatwoot conversation.
 * Automatically splits into multiple messages with photos if property blocks are detected.
 */
export const sendAIResponse = async (
  conversationId: number | string,
  aiReply: string,
  config?: ChatwootConfig | null
): Promise<{ sent: number; errors: number }> => {
  const cfg = config || getChatwootConfig();
  if (!cfg) return { sent: 0, errors: 0 };

  const segments = parseResponseSegments(aiReply);
  let sent = 0;
  let errors = 0;

  for (const segment of segments) {
    let result: SendTextResult;

    if (segment.type === "photo") {
      result = await sendChatwootMediaMessage(conversationId, segment.content, undefined, cfg);
    } else {
      result = await sendChatwootTextMessage(conversationId, segment.content, cfg);
    }

    if (result.ok) {
      sent++;
    } else {
      errors++;
      console.error("[chatwoot][sendAI] segment failed", { type: segment.type, error: result.error });
    }

    // Small delay between messages to preserve ordering in Chatwoot
    if (segments.length > 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return { sent, errors };
};
