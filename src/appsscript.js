// HTTPS client for the Google Apps Script web app. This is the ONLY path from
// the Node service to Sheets + Calendar. Every request carries the shared
// secret, which the Apps Script side verifies.

const WEBAPP_URL = process.env.APPS_SCRIPT_WEBAPP_URL;
const SHARED_SECRET = process.env.APPS_SCRIPT_SHARED_SECRET;

// Generic call to the Apps Script doPost router.
// action: one of "upsert_lead" | "get_slots" | "book_appointment"
// payload: action-specific data object.
async function call(action, payload = {}) {
  if (!WEBAPP_URL) {
    return { ok: false, reason: "APPS_SCRIPT_WEBAPP_URL not configured" };
  }

  const body = JSON.stringify({ action, secret: SHARED_SECRET, ...payload });

  try {
    const res = await fetch(WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "follow", // Apps Script /exec issues a 302 to googleusercontent
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: `non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      };
    }

    if (!res.ok) {
      return { ok: false, reason: data.reason || `HTTP ${res.status}` };
    }
    return data;
  } catch (err) {
    return { ok: false, reason: `request failed: ${err.message}` };
  }
}

export function upsertLead(lead) {
  return call("upsert_lead", { lead });
}

export function getSlots(date) {
  return call("get_slots", { date });
}

export function bookAppointment(booking) {
  return call("book_appointment", { booking });
}

export function cancelAppointment(booking) {
  return call("cancel_appointment", { booking });
}

export function getDashboardData() {
  return call("dashboard");
}

// Admin only — not wired to any agent tool. Deletes the lead row + its event.
export function deleteLead(phone) {
  return call("delete_lead", { lead: { phone } });
}

// Admin only — (re)apply sheet formatting and drop the legacy Visits tab.
export function formatSheet() {
  return call("format_sheet");
}

// Admin only — wipe all lead rows (keeps the header). For clearing test data.
export function resetSheet() {
  return call("reset_sheet");
}

// Admin only — mark the owner unavailable by creating a Calendar block event.
// getSlots excludes overlapping events, so this removes the blocked slots.
export function blockTime(block) {
  return call("block_time", { block });
}

// Admin only — list upcoming availability blocks within `days` (default 30).
export function listBlocks(days = 30) {
  return call("list_blocks", { days });
}

// Admin only — remove a block by its Calendar event id.
export function removeBlock(id) {
  return call("remove_block", { id });
}

export default {
  upsertLead,
  getSlots,
  bookAppointment,
  cancelAppointment,
  getDashboardData,
  deleteLead,
  formatSheet,
  resetSheet,
  blockTime,
  listBlocks,
  removeBlock,
  call,
};
