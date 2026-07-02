import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point state at a throwaway DB before importing the modules that open it.
process.env.CONVERSATIONS_DB = join(mkdtempSync(join(tmpdir(), "re-")), "t.db");

const { runTool, flushLeadToSheet } = await import("../src/tools.js");
const { getState } = await import("../src/state.js");
const appsscript = (await import("../src/appsscript.js")).default;

// Capture Apps Script upserts without hitting the network.
let upsertCalls = [];
appsscript.upsertLead = async (lead) => {
  upsertCalls.push(lead);
  return { ok: true };
};

test("flushLeadToSheet writes qualifying/qualified leads to the Sheet", async () => {
  upsertCalls = [];
  const state = getState("t-flush-qual");
  await runTool("save_field", { field: "intent", value: "buy" }, { state });
  assert.equal(state.stage, "qualifying");
  const res = await flushLeadToSheet(state);
  assert.equal(res.ok, true);
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].phone, "t-flush-qual");
  assert.equal(upsertCalls[0].intent, "buy");
});

test("flushLeadToSheet skips new/booked/handoff leads (no wasted write)", async () => {
  upsertCalls = [];
  const fresh = getState("t-flush-new"); // stage 'new', nothing learned
  const r1 = await flushLeadToSheet(fresh);
  assert.equal(r1.skipped, true);

  const booked = getState("t-flush-booked");
  booked.stage = "booked";
  const r2 = await flushLeadToSheet(booked);
  assert.equal(r2.skipped, true);

  assert.equal(upsertCalls.length, 0);
});

test("save_field persists a known field", async () => {
  const state = getState("t-known");
  const res = await runTool("save_field", { field: "intent", value: "buy" }, { state });
  assert.equal(res.ok, true);
  assert.equal(state.fields.intent, "buy");
});

test("save_field rejects an unknown field key", async () => {
  const state = getState("t-unknown");
  const res = await runTool("save_field", { field: "hacker", value: "x" }, { state });
  assert.equal(res.ok, false);
  assert.equal(state.fields.hacker, undefined);
});

test("save_field requires a field name", async () => {
  const state = getState("t-missing");
  const res = await runTool("save_field", { value: "x" }, { state });
  assert.equal(res.ok, false);
});

test("get_slots requires a date", async () => {
  const state = getState("t-slots");
  const res = await runTool("get_slots", {}, { state });
  assert.equal(res.ok, false);
});

test("book_appointment requires a datetime", async () => {
  const state = getState("t-book");
  const res = await runTool("book_appointment", {}, { state });
  assert.equal(res.ok, false);
});

test("handoff_to_human flags the escalation and stage", async () => {
  const state = getState("t-handoff");
  const res = await runTool("handoff_to_human", { reason: "angry" }, { state });
  assert.equal(res.ok, true);
  assert.equal(res.handoff, true);
  assert.equal(state.stage, "handoff");
});

test("save_field advances stage qualifying -> qualified as fields fill in", async () => {
  const state = getState("t-stage");
  assert.equal(state.stage, "new");

  await runTool("save_field", { field: "intent", value: "buy" }, { state });
  assert.equal(state.stage, "qualifying");

  await runTool("save_field", { field: "budget_max", value: "80 lakh" }, { state });
  await runTool("save_field", { field: "area_locality", value: "Wakad" }, { state });
  assert.equal(state.stage, "qualifying");

  await runTool("save_field", { field: "configuration", value: "3BHK" }, { state });
  assert.equal(state.stage, "qualified");
});

test("field collection never pulls a lead back out of a terminal stage", async () => {
  const state = getState("t-stage-terminal");
  state.stage = "booked";
  await runTool("save_field", { field: "notes", value: "called back" }, { state });
  assert.equal(state.stage, "booked");
});

test("unknown tool returns a clean error", async () => {
  const state = getState("t-nope");
  const res = await runTool("does_not_exist", {}, { state });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown tool/);
});
