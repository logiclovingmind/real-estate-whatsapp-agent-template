import { test } from "node:test";
import assert from "node:assert/strict";
import { trimHistory } from "../src/state.js";

const U = (t) => ({ role: "user", content: t });
const A = (t) => ({ role: "assistant", content: t });
const ATC = (id) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, function: { name: "save_field", arguments: "{}" } }],
});
const TOOL = (id) => ({ role: "tool", tool_call_id: id, content: "{}" });

// A clean transcript of two complete tool-using turns.
const transcript = () => [
  U("hi"), ATC("a"), TOOL("a"), A("hello"),
  U("2bhk"), ATC("b"), TOOL("b"), A("got it"),
];

test("returns history unchanged when within the limit", () => {
  const h = transcript();
  assert.deepEqual(trimHistory(h, 20), h);
});

test("trims to a window that starts on a user message", () => {
  const h = transcript(); // length 8
  const out = trimHistory(h, 3);
  assert.equal(out[0].role, "user");
});

test("never leaves an orphaned leading tool message", () => {
  const h = transcript();
  // A naive slice(-2) would start with a `tool` message (orphaned from its
  // assistant tool_calls) and 400 the API. trimHistory must avoid that.
  const out = trimHistory(h, 2);
  assert.notEqual(out[0].role, "tool");
  assert.equal(out[0].role, "user");
  // Every tool message in the window is preceded by an assistant tool_calls.
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "tool") {
      assert.ok(out[i - 1] && Array.isArray(out[i - 1].tool_calls));
    }
  }
});

test("falls back to the last user turn when the tail window has no user msg", () => {
  const h = transcript();
  const out = trimHistory(h, 1); // tail of 1 is the trailing assistant text
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "2bhk");
});
