// CLI to chat with the agent without WhatsApp or Meta. Uses the same agent +
// state code, so behavior matches production. Apps Script calls will no-op
// gracefully unless APPS_SCRIPT_WEBAPP_URL is set in your .env.
//
//   node test/simulate.js [phone]
//
// Type messages, press enter. Ctrl+C to quit. Each run reuses state keyed by
// the phone arg (default "sim-1"), so you can resume a conversation.

import "dotenv/config";
import readline from "node:readline";
import { getState } from "../src/state.js";
import { handleMessage } from "../src/agent.js";

const phone = process.argv[2] || "sim-1";

if (!process.env.AICREDITS_API_KEY) {
  console.error(
    "Set AICREDITS_API_KEY in .env to talk to the model. (Copy .env.example -> .env)"
  );
  process.exit(1);
}

const state = getState(phone);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "you  > ",
});

console.log(`Simulating WhatsApp chat as ${phone}. Ctrl+C to quit.\n`);
rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  try {
    const { reply, handoff, handoffReason } = await handleMessage(state, text, {
      onHandoff: async (reason) =>
        console.log(`  [owner notified: ${reason}]`),
    });
    console.log(`agent> ${reply}`);
    if (handoff) console.log(`  [handoff flagged: ${handoffReason}]`);
    console.log(`  [stage: ${state.stage} | fields: ${Object.keys(state.fields).join(", ") || "none"}]\n`);
  } catch (err) {
    console.error("error:", err.message);
  }
  rl.prompt();
});

rl.on("close", () => {
  console.log("\nbye");
  process.exit(0);
});
