import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseInbound, verifySignature, stripMarkdown } from "../src/whatsapp.js";

test("stripMarkdown flattens bold, links, headings for WhatsApp", () => {
  assert.equal(stripMarkdown("**Date:** 6:15 PM"), "Date: 6:15 PM");
  assert.equal(
    stripMarkdown("[Visit Link](https://cal.example/e?eid=abc)"),
    "https://cal.example/e?eid=abc"
  );
  assert.equal(stripMarkdown("## Slots\n1. **10 AM**"), "Slots\n1. 10 AM");
  assert.equal(stripMarkdown("plain text"), "plain text");
});

test("parseInbound extracts a text message", () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: "Asha" } }],
              messages: [
                { from: "9199999", id: "wamid.1", type: "text", text: { body: "hello" } },
              ],
            },
          },
        ],
      },
    ],
  };
  const out = parseInbound(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, "9199999");
  assert.equal(out[0].text, "hello");
  assert.equal(out[0].messageId, "wamid.1");
  assert.equal(out[0].contactName, "Asha");
});

test("parseInbound returns [] for status callbacks", () => {
  const body = {
    entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }],
  };
  assert.deepEqual(parseInbound(body), []);
});

test("parseInbound returns every batched message", () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: "91", id: "a", type: "text", text: { body: "one" } },
                { from: "91", id: "b", type: "text", text: { body: "two" } },
              ],
            },
          },
        ],
      },
    ],
  };
  const out = parseInbound(body);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.text), ["one", "two"]);
});

test("parseInbound flags unsupported (non-text) messages", () => {
  const body = {
    entry: [
      { changes: [{ value: { messages: [{ from: "91", type: "image" }] } }] },
    ],
  };
  const out = parseInbound(body);
  assert.equal(out[0].unsupported, true);
});

test("verifySignature accepts a correct HMAC and rejects a bad one", () => {
  process.env.WHATSAPP_APP_SECRET = "topsecret";
  const raw = Buffer.from(JSON.stringify({ a: 1 }));
  const sig =
    "sha256=" +
    crypto.createHmac("sha256", "topsecret").update(raw).digest("hex");
  assert.equal(verifySignature(raw, sig), true);
  assert.equal(verifySignature(raw, "sha256=deadbeef"), false);
  assert.equal(verifySignature(raw, undefined), false);
});
