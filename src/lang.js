// Lightweight language/script detection for v1.
// Returns one of: "gu" (Gujarati script/Roman), "hi" (Devanagari), "hinglish"
// (Roman Hindi/Hinglish), "en" (English), or "und" (undetermined — no language
// signal at all, e.g. a bare "ok" or "60 lakh").
//
// Session lock: the caller locks the language on the lead's first message that
// carries a signal, then passes that locked language back as `current` on every
// later turn. Once locked, we only switch when ANOTHER language wins by a clear
// margin (a whole message in that language) — a single ambiguous token (e.g.
// "hu", Gujarati "I" but also Hinglish "hoon") will NOT flip an established chat.

const GUJARATI_RANGE = /[\u0A80-\u0AFF]/;
const DEVANAGARI_RANGE = /[\u0900-\u097F]/;

// Common Hinglish/Hindi tokens written in Roman script.
// NOTE: keep only tokens that are distinctly Hindi/Hinglish. Generic English
// real-estate words ("flat", "budget", "area") are intentionally absent — they
// made pure English leads (e.g. "I want a 3BHK flat") misclassify as Hinglish.
const HINGLISH_HINTS = [
  "hai", "haan", "nahi", "nahin", "kya", "kaise", "kaisa", "kitna",
  "kitne", "chahiye", "chaiye", "milega", "batao", "bata", "karo", "kar",
  "karwa", "acha", "accha", "theek", "thik", "ghar", "lena", "lege", "lunga",
  "dekhna", "dikhao", "dikha", "paisa", "rupaye", "hajar", "hazar", "tak",
  "subah", "shaam", "sham", "wala", "wali", "bhai", "ji",
  "aap", "tum", "mujhe", "mereko", "apna", "kal", "aaj", "abhi", "kab",
];

// Common Roman-Gujarati tokens (helps bias toward Gujarati register).
const GUJARATI_ROMAN_HINTS = [
  "chhe", "che", "shu", "kem", "tame", "tamne", "hu", "mane", "amne", "joiye",
  "ketlo", "ketli", "ketla", "ketlu", "ghar", "aapo", "batavo", "kaho", "kyare",
  "rakho", "rakhyu", "saru", "saras", "sudhi", "levu", "leva", "bhade", "bhav",
  "gothvi", "barabar", "shanivar", "ravivar", "maate", "mate", "aavso", "karva",
  "thai", "gayu", "vagya", "vagye", "saro", "lage", "kayo", "kayu", "kai",
  "divas", "rubaru", "parmadivse", "kale", "aaje", "vandho",
];

// Distinctly English function/words — used to tell "clearly English" apart from
// "no signal". Real-estate nouns that also appear in Hinglish are excluded.
// Loanwords used across all three languages ("visit", "book", "do") are
// deliberately excluded — they aren't English discriminators.
const ENGLISH_HINTS = [
  "the", "is", "are", "what", "want", "you", "your", "can", "does",
  "i", "we", "for", "with", "have", "will", "would",
  "please", "yes", "looking", "buy", "rent", "price", "this", "that", "how",
  "when", "where", "which", "and", "of", "my", "need", "show",
  "available", "interested", "morning", "evening", "works", "fine",
];

// How much stronger another language must score than the locked one before we
// switch the conversation. A margin of 2 means a single shared/ambiguous token
// can't flip the chat, but a whole message in another language will.
const SWITCH_MARGIN = 2;

function countHits(text, words) {
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const set = new Set(tokens);
  let hits = 0;
  for (const w of words) if (set.has(w)) hits++;
  return hits;
}

export function detectLanguage(text = "", current) {
  const t = String(text).trim();
  if (!t) return "und";

  // Actual script is definitive — always wins over any romanized heuristic.
  if (GUJARATI_RANGE.test(t)) return "gu";
  if (DEVANAGARI_RANGE.test(t)) return "hi";

  const guHits = countHits(t, GUJARATI_ROMAN_HINTS);
  const hiHits = countHits(t, HINGLISH_HINTS);
  const enHits = countHits(t, ENGLISH_HINTS);

  // No evidence in any language — let the caller keep the current language.
  if (guHits === 0 && hiHits === 0 && enHits === 0) return "und";

  // Strongest signal. Roman Gujarati and Hinglish share many tokens, so ties
  // between them lean Gujarati (default bias for Gujarat-based clients).
  let winner, winnerHits;
  if (guHits >= hiHits && guHits >= enHits && guHits > 0) {
    winner = "gu";
    winnerHits = guHits;
  } else if (hiHits >= enHits && hiHits > 0) {
    winner = "hinglish";
    winnerHits = hiHits;
  } else {
    winner = "en";
    winnerHits = enHits;
  }

  // Session lock: if a language is already established, keep it unless another
  // beats it by SWITCH_MARGIN. Devanagari "hi" is compared via its Roman score.
  const curLabel = current === "hi" ? "hinglish" : current;
  const curHits =
    curLabel === "gu" ? guHits : curLabel === "hinglish" ? hiHits : curLabel === "en" ? enHits : -1;
  if (curHits >= 0 && winner !== curLabel && winnerHits - curHits < SWITCH_MARGIN) {
    return curLabel;
  }
  return winner;
}

// Human-readable label for the system prompt.
export function languageLabel(code) {
  switch (code) {
    case "gu":
      return "Gujarati (reply in Roman Gujarati unless the lead used Gujarati script)";
    case "hi":
      return "Hindi (Devanagari script)";
    case "hinglish":
      return "Hinglish (Roman script Hindi)";
    default:
      return "English";
  }
}
