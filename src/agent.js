// The LLM loop: build messages -> call the model (AICredits, OpenAI-compatible)
// -> dispatch any tool calls -> loop until the model produces a text reply.

import OpenAI from "openai";
import { buildSystemPrompt } from "./prompts/system.js";
import { detectLanguage } from "./lang.js";
import { toolSchemas, runTool, flushLeadToSheet } from "./tools.js";
import { appendHistory, saveState } from "./state.js";

const MODEL = process.env.MODEL || "openai/gpt-4o-mini";
const MAX_TOOL_ROUNDS = 5;

// Lazy so importing this module (e.g. in tests) doesn't require a key.
let _client;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.AICREDITS_API_KEY,
      baseURL: process.env.AICREDITS_BASE_URL || "https://api.aicredits.in/v1",
    });
  }
  return _client;
}

// Run one inbound user message through the agent. Returns { reply, handoff }.
// `state` is mutated + persisted as fields are learned. `onHandoff` (optional)
// is called with the reason so the caller can notify the owner.
export async function handleMessage(state, userText, { onHandoff } = {}) {
  // Language is LOCKED to the lead's first message that carries a signal. Until
  // then we detect fresh; once locked we pass the locked language as `current`
  // so detectLanguage only switches on a clear, full-message signal in another
  // language — a bare "ok"/"60 lakh" or a single ambiguous token ("hu") can't
  // reset or flip the conversation.
  const detected = detectLanguage(userText, state.langLocked ? state.language : undefined);
  if (detected !== "und") {
    state.language = detected;
    state.langLocked = true;
  }
  if (!state.language) state.language = "en";

  appendHistory(state, { role: "user", content: userText });
  saveState(state);

  let handoffReason = null;
  // Track tool activity across rounds so we can deterministically sync the lead
  // to the Sheet at the end of the turn — the model can't be trusted to call
  // upsert_lead, so qualified-but-not-booked leads would otherwise never land in
  // the CRM (and never show up in the dashboard's "Leads to call").
  let savedField = false;
  let upsertedThisTurn = false;
  const flushLead = async () => {
    if (savedField && !upsertedThisTurn) {
      try {
        await flushLeadToSheet(state);
      } catch {
        /* CRM sync failure must not break the reply to the lead */
      }
    }
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const messages = [
      { role: "system", content: buildSystemPrompt(state, state.language) },
      ...state.history,
    ];

    const completion = await getClient().chat.completions.create({
      model: MODEL,
      messages,
      tools: toolSchemas,
      tool_choice: "auto",
      temperature: 0.3,
    });

    const choice = completion.choices?.[0]?.message;
    if (!choice) {
      return { reply: fallbackReply(state.language), handoff: false };
    }

    // No tool calls -> we have the final reply for this turn.
    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      const reply = (choice.content || "").trim() || fallbackReply(state.language);
      appendHistory(state, { role: "assistant", content: reply });
      saveState(state);
      await flushLead();
      return { reply, handoff: Boolean(handoffReason), handoffReason };
    }

    // Record the assistant turn that requested tools.
    appendHistory(state, {
      role: "assistant",
      content: choice.content || "",
      tool_calls: choice.tool_calls,
    });

    // Execute each tool call and append its result.
    for (const call of choice.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }

      const result = await runTool(name, args, { state });

      if (name === "save_field" && result?.ok) savedField = true;
      if (name === "upsert_lead" || name === "book_appointment") {
        upsertedThisTurn = true;
      }

      if (name === "handoff_to_human" && result?.handoff) {
        handoffReason = result.reason || "unspecified";
        if (typeof onHandoff === "function") {
          try {
            await onHandoff(handoffReason, state);
          } catch {
            /* notification failure must not break the turn */
          }
        }
      }

      appendHistory(state, {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
    saveState(state);
  }

  // Ran out of tool rounds. Make one final call with tools disabled so the
  // model must produce a text reply (using everything it just gathered) instead
  // of leaving the lead with a generic fallback.
  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt(state, state.language) },
        ...state.history,
      ],
      tool_choice: "none",
      temperature: 0.3,
    });
    const content = completion.choices?.[0]?.message?.content?.trim();
    if (content) {
      appendHistory(state, { role: "assistant", content });
      saveState(state);
      await flushLead();
      return { reply: content, handoff: Boolean(handoffReason), handoffReason };
    }
  } catch {
    /* fall through to the canned reply below */
  }

  const reply = fallbackReply(state.language);
  appendHistory(state, { role: "assistant", content: reply });
  saveState(state);
  await flushLead();
  return { reply, handoff: Boolean(handoffReason), handoffReason };
}

function fallbackReply(language) {
  switch (language) {
    case "hinglish":
      return "Ek minute, main aapki team se confirm karke batata hoon.";
    case "gu":
      return "Ek minute, hu team sathe confirm karine janavu chhu.";
    case "hi":
      return "एक मिनट, मैं टीम से पुष्टि करके बताता हूँ।";
    default:
      return "One moment — let me check with the team and get back to you.";
  }
}

export default { handleMessage };
