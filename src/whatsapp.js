// WhatsApp Cloud API helpers: verify inbound signatures, parse inbound
// messages, and send outbound text/template messages via the Graph API.

import crypto from "node:crypto";

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v23.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

// Verify X-Hub-Signature-256. `rawBody` must be the exact bytes Meta sent.
// Read the secret at call time so tests and late-loaded .env both work.
export function verifySignature(rawBody, signatureHeader) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return false;
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Extract every inbound user message from a webhook body, in order. Returns an
// array (empty for status/delivery callbacks, which carry no `messages`). A
// single webhook can batch multiple messages, so callers must handle all of
// them, not just the first.
export function parseInbound(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const contactName = value?.contacts?.[0]?.profile?.name;
    return messages.map((message) => {
      if (message.type !== "text") {
        return {
          from: message.from,
          type: message.type,
          text: "",
          messageId: message.id,
          unsupported: true,
          contactName,
        };
      }
      return {
        from: message.from,
        type: "text",
        text: message.text?.body || "",
        messageId: message.id,
        contactName,
      };
    });
  } catch {
    return [];
  }
}

// Strip Markdown the model sometimes emits — WhatsApp renders **bold**,
// [label](url) and # headings as literal junk. Flatten to clean plain text:
// links become the bare (clickable) URL, emphasis/heading/code markers drop.
export function stripMarkdown(text) {
  if (!text) return text;
  return String(text)
    .replace(/!?\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      /^https?:\/\//i.test(url) ? url : label
    )
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Send a free-form text reply (only valid inside the 24h customer window).
export async function sendText(to, text) {
  if (!TOKEN || !PHONE_NUMBER_ID) {
    return { ok: false, reason: "WhatsApp credentials not configured" };
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: stripMarkdown(text) },
  };
  return graphSend(url, payload);
}

// Send an approved template (needed to re-engage outside the 24h window).
export async function sendTemplate(to, templateName, languageCode = "en", components = []) {
  if (!TOKEN || !PHONE_NUMBER_ID) {
    return { ok: false, reason: "WhatsApp credentials not configured" };
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };
  return graphSend(url, payload);
}

async function graphSend(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: data?.error?.message || `HTTP ${res.status}`, data };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: `send failed: ${err.message}` };
  }
}

export default { verifySignature, parseInbound, sendText, sendTemplate, stripMarkdown };
