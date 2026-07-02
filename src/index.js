// Express webhook service — "the brain". Verifies + parses inbound WhatsApp
// messages, runs them through the agent, and replies. ACKs Meta with 200
// immediately and processes async so Meta doesn't retry.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import {
  verifySignature,
  parseInbound,
  sendText,
  stripMarkdown,
} from "./whatsapp.js";
import { getState, saveState, listConversations, getConversation } from "./state.js";
import { handleMessage } from "./agent.js";
import {
  getDashboardData,
  blockTime,
  listBlocks,
  removeBlock,
} from "./appsscript.js";
import { computeMetrics } from "./dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const HANDOFF_NUMBER = process.env.HUMAN_HANDOFF_NUMBER;

// Capture the raw body so we can verify X-Hub-Signature-256.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health check.
app.get("/", (_req, res) => res.send("ok"));

// --- Dashboard (owner/client facing, Basic Auth protected) ---

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function dashboardAuth(req, res, next) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) {
    return res
      .status(503)
      .send("Dashboard auth not configured. Set DASHBOARD_USER and DASHBOARD_PASS.");
  }
  const [scheme, encoded] = (req.get("authorization") || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
    if (safeEqual(u, user) && safeEqual(p, pass)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Dashboard"');
  return res.status(401).send("Authentication required");
}

app.get("/dashboard", dashboardAuth, (_req, res) => {
  res.type("html").send(readFileSync(join(__dirname, "dashboard.html"), "utf8"));
});

app.get("/api/dashboard", dashboardAuth, async (_req, res) => {
  const data = await getDashboardData();
  if (!data.ok) {
    return res.status(502).json({ ok: false, reason: data.reason || "fetch failed" });
  }
  const metrics = computeMetrics(data.leads || []);
  res.json({
    ok: true,
    businessName: process.env.BUSINESS_NAME || "Real Estate",
    generatedAt: new Date().toISOString(),
    metrics,
  });
});

// --- Availability blocks (owner-only, same Basic Auth) ---
// One-off blocks: mark the owner unavailable so the agent stops offering those
// slots. Backed by Calendar block events; never an agent tool.

app.get("/api/availability", dashboardAuth, async (_req, res) => {
  const data = await listBlocks(30);
  if (!data.ok) {
    return res.status(502).json({ ok: false, reason: data.reason || "fetch failed" });
  }
  res.json({ ok: true, blocks: data.blocks || [] });
});

app.post("/api/availability", dashboardAuth, async (req, res) => {
  const date = String(req.body?.date || "").trim();
  const allDay = Boolean(req.body?.allDay);
  const start = String(req.body?.start || "").trim();
  const end = String(req.body?.end || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!date) {
    return res.status(400).json({ ok: false, reason: "date is required" });
  }
  if (!allDay && (!start || !end)) {
    return res
      .status(400)
      .json({ ok: false, reason: "start and end time are required unless all-day" });
  }
  const data = await blockTime({ date, allDay, start, end, reason });
  if (!data.ok) {
    return res.status(502).json({ ok: false, reason: data.reason || "block failed" });
  }
  res.json(data);
});

app.delete("/api/availability", dashboardAuth, async (req, res) => {
  const id = String(req.query?.id || "").trim();
  if (!id) {
    return res.status(400).json({ ok: false, reason: "id is required" });
  }
  const data = await removeBlock(id);
  if (!data.ok) {
    return res.status(502).json({ ok: false, reason: data.reason || "remove failed" });
  }
  res.json(data);
});

// --- Lead conversations (owner-only, same Basic Auth) ---
// Read-only view of the WhatsApp chat history (from SQLite) so the owner can
// see what each lead actually said. Only user/assistant text turns are shown.

app.get("/api/conversations", dashboardAuth, (_req, res) => {
  res.json({ ok: true, conversations: listConversations() });
});

app.get("/api/conversations/:phone", dashboardAuth, (req, res) => {
  const convo = getConversation(req.params.phone);
  if (!convo) return res.status(404).json({ ok: false, reason: "no conversation for this phone" });
  res.json({ ok: true, conversation: convo });
});

// --- Agent test console (same Basic Auth as the dashboard) ---
// A browser chat that drives the real agent loop, so you can sanity-check
// behavior without WhatsApp/Meta. Conversations are keyed by a "web-*" phone
// the page generates; "New chat" just mints a fresh one. Note: this exercises
// the LIVE agent, so upsert_lead/book_appointment hit the real Sheet/Calendar.

app.get("/chat", dashboardAuth, (_req, res) => {
  res.type("html").send(readFileSync(join(__dirname, "chat.html"), "utf8"));
});

app.get("/api/chat/meta", dashboardAuth, (_req, res) => {
  res.json({ ok: true, businessName: process.env.BUSINESS_NAME || "Real Estate" });
});

app.post("/api/chat", dashboardAuth, async (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!phone || !text) {
    return res.status(400).json({ ok: false, reason: "phone and text required" });
  }
  try {
    const state = getState(phone);
    const { reply, handoff, handoffReason } = await handleMessage(state, text, {
      onHandoff: notifyOwner,
    });
    res.json({
      ok: true,
      reply: stripMarkdown(reply),
      handoff: !!handoff,
      handoffReason: handoffReason || "",
      stage: state.stage,
      fields: state.fields || {},
    });
  } catch (err) {
    console.error("chat console turn failed:", err);
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// Webhook verification (Meta calls this once during setup).
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Inbound messages.
app.post("/webhook", (req, res) => {
  // Verify signature before trusting anything.
  const signature = req.get("X-Hub-Signature-256");
  if (!verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }

  // ACK immediately so Meta doesn't retry; process async.
  res.sendStatus(200);

  for (const inbound of parseInbound(req.body)) {
    if (!inbound.from) continue;
    if (alreadySeen(inbound.messageId)) continue; // Meta re-delivers; dedupe
    // Serialize per phone so two quick messages can't race the read-modify-write
    // of the same conversation state and clobber each other's history.
    enqueue(inbound.from, () => processInbound(inbound)).catch((err) => {
      console.error("processInbound failed:", err);
    });
  }
});

// --- Idempotency: drop messages Meta has already delivered ---
const SEEN_MAX = 5000;
const seenIds = new Map(); // messageId -> insertion order (for simple eviction)
function alreadySeen(id) {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  seenIds.set(id, Date.now());
  if (seenIds.size > SEEN_MAX) {
    // Evict the oldest entry.
    seenIds.delete(seenIds.keys().next().value);
  }
  return false;
}

// --- Per-phone serialization: chain work onto a per-phone promise ---
const queues = new Map(); // phone -> tail Promise
function enqueue(phone, task) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.then(task, task);
  // Clean up the map once this is the last task in the chain.
  queues.set(phone, next);
  next.finally(() => {
    if (queues.get(phone) === next) queues.delete(phone);
  });
  return next;
}

async function processInbound(inbound) {
  const phone = inbound.from;
  const state = getState(phone);

  if (state.fields?.name == null && inbound.contactName) {
    // Seed name from WhatsApp profile if we have nothing yet.
    state.fields = { ...state.fields, name: inbound.contactName };
    saveState(state);
  }

  if (inbound.unsupported) {
    await sendText(
      phone,
      "I can only read text messages here. Could you type your query?"
    );
    return;
  }

  const { reply } = await handleMessage(state, inbound.text, {
    onHandoff: notifyOwner,
  });

  if (reply) await sendText(phone, reply);
}

async function notifyOwner(reason, state) {
  if (!HANDOFF_NUMBER) return;
  const name = state.fields?.name || "Unknown";
  await sendText(
    HANDOFF_NUMBER,
    `Handoff needed for ${name} (${state.phone}): ${reason}`
  );
}

app.listen(PORT, () => {
  console.log(`Real estate WhatsApp agent listening on :${PORT}`);
});

export default app;
