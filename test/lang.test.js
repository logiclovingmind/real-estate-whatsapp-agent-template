import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "../src/lang.js";

test("detects English", () => {
  assert.equal(detectLanguage("Hi, I'm looking for a 2BHK in town"), "en");
});

test("detects Hinglish (Roman)", () => {
  assert.equal(detectLanguage("bhai mujhe 2bhk chahiye budget kitna"), "hinglish");
});

test("detects Gujarati script", () => {
  assert.equal(detectLanguage("મને ઘર જોઈએ છે"), "gu");
});

test("detects Devanagari Hindi", () => {
  assert.equal(detectLanguage("मुझे घर चाहिए"), "hi");
});

test("detects Roman Gujarati via hints", () => {
  assert.equal(detectLanguage("mane ghar joiye che ketlo bhav"), "gu");
});

test("empty or signal-less input is undetermined (caller keeps current lang)", () => {
  assert.equal(detectLanguage(""), "und");
  assert.equal(detectLanguage(undefined), "und");
  // Bare acknowledgements / numbers carry no language signal.
  assert.equal(detectLanguage("ok"), "und");
  assert.equal(detectLanguage("ha"), "und");
  assert.equal(detectLanguage("60 lakh"), "und");
});

test("short Gujarati/Hinglish replies still detect (not 'und')", () => {
  assert.equal(detectLanguage("60 lakh sudhi"), "gu");
  assert.equal(detectLanguage("shanivar barabar"), "gu");
  assert.equal(detectLanguage("25 hajar tak"), "hinglish");
});

test("loanwords (visit/book/do) don't force English", () => {
  assert.equal(detectLanguage("ha visit gothvi do"), "gu");
});

test("locked language doesn't flip on a single ambiguous token", () => {
  // "hu" is a Gujarati hint but also Hinglish "hoon"; in a locked Hinglish chat
  // it must NOT switch the conversation to Gujarati.
  assert.equal(detectLanguage("kal me dupher ke baad me free hi hu", "hinglish"), "hinglish");
  // A whole message clearly in another language still switches (beats by margin).
  assert.equal(detectLanguage("mane ghar joiye che ketlo bhav", "hinglish"), "gu");
  // Without a locked language (first message), detection is unconstrained.
  assert.equal(detectLanguage("bhai mujhe 2bhk chahiye budget kitna"), "hinglish");
  // A locked English chat isn't flipped by one stray Hindi word.
  assert.equal(detectLanguage("ok ghar", "en"), "en");
});
