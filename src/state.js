// SQLite-backed conversation state, keyed by phone number.
// Stores ephemeral chat memory + current stage + the lead fields learned so
// far. Business records (the durable lead row / booking) live in the Sheet via
// Apps Script — never here.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.CONVERSATIONS_DB || "db/conversations.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    phone        TEXT PRIMARY KEY,
    stage        TEXT NOT NULL DEFAULT 'new',
    language     TEXT NOT NULL DEFAULT 'en',
    lang_locked  INTEGER NOT NULL DEFAULT 0,
    fields_json  TEXT NOT NULL DEFAULT '{}',
    history_json TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Additive migration for DBs created before lang_locked existed.
const hasLangLocked = db
  .prepare("PRAGMA table_info(conversations)")
  .all()
  .some((c) => c.name === "lang_locked");
if (!hasLangLocked) {
  db.exec("ALTER TABLE conversations ADD COLUMN lang_locked INTEGER NOT NULL DEFAULT 0");
}

const selectStmt = db.prepare("SELECT * FROM conversations WHERE phone = ?");
const insertStmt = db.prepare(
  `INSERT INTO conversations (phone) VALUES (?)`
);
const updateStmt = db.prepare(
  `UPDATE conversations
   SET stage = @stage,
       language = @language,
       lang_locked = @lang_locked,
       fields_json = @fields_json,
       history_json = @history_json,
       updated_at = datetime('now')
   WHERE phone = @phone`
);

const MAX_HISTORY = 20; // keep history trimmed to control model cost

// Trim history without splitting a tool-call sequence. The OpenAI API requires
// every assistant `tool_calls` message to be followed by a `tool` result for
// each id; slicing blindly can leave an orphaned leading `tool` message (or an
// assistant `tool_calls` whose results were cut) and 400 the next request. So
// we keep at most `max` messages but always start the window on a `user`
// message — a clean turn boundary — even if that keeps a few extra.
export function trimHistory(history, max = MAX_HISTORY) {
  if (!Array.isArray(history) || history.length <= max) return history || [];
  let start = history.length - max;
  while (start < history.length && history[start].role !== "user") start++;
  if (start >= history.length) {
    // No user message in the tail window; fall back to the last user turn.
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") return history.slice(i);
    }
    return history.slice(-max);
  }
  return history.slice(start);
}

function rowToState(row) {
  return {
    phone: row.phone,
    stage: row.stage,
    language: row.language,
    langLocked: Boolean(row.lang_locked),
    fields: JSON.parse(row.fields_json),
    history: JSON.parse(row.history_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getState(phone) {
  let row = selectStmt.get(phone);
  if (!row) {
    insertStmt.run(phone);
    row = selectStmt.get(phone);
  }
  return rowToState(row);
}

export function saveState(state) {
  const history = trimHistory(state.history, MAX_HISTORY);
  updateStmt.run({
    phone: state.phone,
    stage: state.stage || "new",
    language: state.language || "en",
    lang_locked: state.langLocked ? 1 : 0,
    fields_json: JSON.stringify(state.fields || {}),
    history_json: JSON.stringify(history),
  });
}

// Keep only the user/assistant text turns — drop tool calls and tool results,
// which are plumbing the owner shouldn't see in a chat transcript.
function visibleTurns(history) {
  return (history || []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content && String(m.content).trim()
  );
}

const listStmt = db.prepare(
  `SELECT phone, stage, fields_json, history_json, updated_at
   FROM conversations ORDER BY updated_at DESC`
);

// All conversations as lightweight rows for the dashboard list (no full
// history) — name (if learned), stage, last message snippet, message count.
export function listConversations() {
  return listStmt.all().map((row) => {
    const fields = JSON.parse(row.fields_json);
    const turns = visibleTurns(JSON.parse(row.history_json));
    const last = turns[turns.length - 1];
    return {
      phone: row.phone,
      name: fields.name || "",
      stage: row.stage,
      lastMessage: last ? String(last.content) : "",
      lastRole: last ? last.role : "",
      messageCount: turns.length,
      updatedAt: row.updated_at,
    };
  });
}

// One conversation's full visible transcript for the dashboard chat view.
export function getConversation(phone) {
  const row = selectStmt.get(phone);
  if (!row) return null;
  const fields = JSON.parse(row.fields_json);
  return {
    phone: row.phone,
    name: fields.name || "",
    stage: row.stage,
    language: row.language,
    messages: visibleTurns(JSON.parse(row.history_json)).map((m) => ({
      role: m.role,
      content: String(m.content),
    })),
    updatedAt: row.updated_at,
  };
}

// Merge a single learned field into state.fields (used by save_field tool).
export function setField(state, key, value) {
  state.fields = { ...state.fields, [key]: value };
  return state;
}

export function appendHistory(state, message) {
  state.history = [...(state.history || []), message];
  return state;
}

export default db;
