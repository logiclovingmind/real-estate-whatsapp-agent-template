/**
 * Google Apps Script Web App — the ONLY thing that touches Sheets + Calendar.
 * Reached over HTTPS by the Node service with a shared secret.
 *
 * SECURITY: client secrets (SHARED_SECRET) and IDs (SHEET_ID, CALENDAR_ID) are
 * read from Script Properties, NOT stored in this file — so this source can be
 * shared/committed safely and reused per client. Set them once after pasting:
 * paste your values into setup() below, Run setup once, then blank them again.
 * (Or set them by hand in Project Settings -> Script Properties.)
 * SHARED_SECRET must match APPS_SCRIPT_SHARED_SECRET in the Node .env.
 *
 * Then deploy as a Web App and copy the /exec URL — paste, set props, deploy.
 *
 * DATA MODEL: a SINGLE sheet ("Leads") — one row per lead, keyed by phone.
 * Booking details live on the lead row (Site Visit + hidden event id). There is
 * no separate Visits tab. Technical columns (event id, language, budget_min)
 * are kept for the code but HIDDEN so the owner sees only useful info.
 */

// One-time per client: fill these in, Run `setup`, then clear them back to "".
// Never commit real values here.
function setup() {
  PropertiesService.getScriptProperties().setProperties({
    SHARED_SECRET: "",
    SHEET_ID: "",
    CALENDAR_ID: "",
  });
}

// Non-secret defaults only. Safe to keep in source.
// Override per client via Script Properties (same names) without editing source.
var CONFIG = {
  BUSINESS_HOURS: "10:00-19:00",
  WORKING_DAYS: "Mon,Tue,Wed,Thu,Fri,Sat",
  VISIT_DURATION_MIN: "45",
  TIMEZONE: "Asia/Kolkata",
};

var TZ = prop("TIMEZONE");

var SHEET_NAME = "Leads";

// Title prefix for owner availability blocks. getSlots already excludes any
// overlapping Calendar event, so a block event simply removes those slots. The
// prefix lets us list/remove only blocks (never real bookings) safely.
var BLOCK_PREFIX = "[BLOCKED]";

// The single source of truth for the sheet layout. `key` is the machine name
// the Node code/agent uses; `label` is the human header the owner sees; columns
// are laid out left-to-right in THIS order, most useful first. `hidden` columns
// stay in the data (the code needs them) but are hidden from view.
var COLUMNS = [
  { key: "name",           label: "Name",            w: 160 },
  { key: "phone",          label: "Phone",           w: 130 },
  { key: "stage",          label: "Status",          w: 120 },
  { key: "intent",         label: "Looking To",      w: 95 },
  { key: "configuration",  label: "Config",          w: 85 },
  { key: "property_type",  label: "Property",        w: 105 },
  { key: "area_locality",  label: "Preferred Area",  w: 180 },
  { key: "budget_display", label: "Budget",          w: 130 },
  { key: "visit_datetime", label: "Site Visit",      w: 165 },
  { key: "possession",     label: "Possession",      w: 125 },
  { key: "purpose",        label: "Purpose",         w: 110 },
  { key: "financing",      label: "Financing",       w: 100 },
  { key: "preferred_time", label: "Preferred Time",  w: 130 },
  { key: "source",         label: "Source",          w: 115 },
  { key: "notes",          label: "Notes",           w: 280 },
  { key: "timestamp",      label: "First Contact",   w: 155 },
  { key: "last_updated",   label: "Last Updated",    w: 155 },
  { key: "language",       label: "language",        w: 80,  hidden: true },
  { key: "budget_min",     label: "budget_min",      w: 90,  hidden: true },
  { key: "budget_max",     label: "budget_max",      w: 90,  hidden: true },
  { key: "visit_event_id", label: "event_id",        w: 150, hidden: true },
];

var KEYS = COLUMNS.map(function (c) { return c.key; });
var LABELS = COLUMNS.map(function (c) { return c.label; });

function colNum(key) {
  return KEYS.indexOf(key) + 1; // 1-based column number, 0 if not found
}

function prop(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v == null || v === "") v = CONFIG[key];
  return v == null ? fallback : v;
}

function doGet() {
  return json({ ok: true, service: "real-estate-agent", status: "healthy", version: "v12-blocks" });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, reason: "invalid JSON" });
  }

  if (body.secret !== prop("SHARED_SECRET")) {
    return json({ ok: false, reason: "unauthorized" });
  }

  try {
    switch (body.action) {
      case "upsert_lead":
        return json(upsertLead(body.lead || {}));
      case "get_slots":
        return json(getSlots(body.date));
      case "book_appointment":
        return json(bookAppointment(body.booking || {}));
      case "cancel_appointment":
        return json(cancelAppointment(body.booking || {}));
      case "dashboard":
        return json(getDashboardData());
      // --- Admin only (never exposed as an agent tool; secret-gated) ---
      case "delete_lead":
        return json(deleteLead(body.lead || {}));
      case "format_sheet":
        return json(formatSheetAction());
      case "reset_sheet":
        return json(resetSheet());
      case "block_time":
        return json(blockTime(body.block || {}));
      case "list_blocks":
        return json(listBlocks(body.days));
      case "remove_block":
        return json(removeBlock(body.id));
      default:
        return json({ ok: false, reason: "unknown action: " + body.action });
    }
  } catch (err) {
    return json({ ok: false, reason: "server error: " + err.message });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/* ---------------- Sheets ---------------- */

// Open (or create) the single Leads sheet, ensure its header row matches the
// readable LABELS, and apply formatting once on first creation.
function getSheet() {
  var ss = SpreadsheetApp.openById(prop("SHEET_ID"));
  var sheet = ss.getSheetByName(SHEET_NAME);
  var fresh = false;
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    fresh = true;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LABELS);
    fresh = true;
  } else {
    // Keep the header in sync if the layout changed between versions.
    var head = sheet.getRange(1, 1, 1, LABELS.length).getValues()[0];
    if (head.join("\u0001") !== LABELS.join("\u0001")) {
      sheet.getRange(1, 1, 1, LABELS.length).setValues([LABELS]);
    }
  }
  if (fresh) formatSheet(sheet);
  return sheet;
}

function now() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
}

// Read-only snapshot for the dashboard. Rows are keyed by MACHINE key (not the
// readable header), so the Node dashboard keeps working regardless of labels.
function getDashboardData() {
  var sheet = getSheet();
  if (sheet.getLastRow() < 2) return { ok: true, leads: [] };
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, KEYS.length).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var row = {};
    for (var c = 0; c < KEYS.length; c++) {
      var v = data[i][c];
      row[KEYS[c]] = v instanceof Date
        ? Utilities.formatDate(v, TZ, "yyyy-MM-dd HH:mm:ss")
        : v;
    }
    out.push(row);
  }
  return { ok: true, leads: out };
}

function findRow(sheet, phone) {
  if (sheet.getLastRow() < 2) return -1;
  var phoneCol = colNum("phone");
  var vals = sheet.getRange(2, phoneCol, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(phone)) return i + 2; // 1-based sheet row
  }
  return -1;
}

// Convert a freeform budget value ("80 lakh", "0.8 cr", 8000000, "₹80,00,000")
// to a number of rupees. Raw budget_min/budget_max stay in the (hidden) data;
// this only drives the readable "Budget" display column.
// Convert a freeform budget to rupees. For rent, bare numbers are literal
// monthly amounts (25000 -> ₹25,000); for buy/invest a bare number is assumed
// to be lakhs (80 -> ₹80 L), which is how people quote purchase budgets.
function toRupees(raw, isRent) {
  if (raw == null || raw === "") return null;
  var s = String(raw).toLowerCase().replace(/,/g, "").replace(/₹/g, "").trim();
  var m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  if (/cr|crore/.test(s)) return n * 1e7;
  if (/lakh|lac|lak/.test(s)) return n * 1e5;
  if (/thousand/.test(s) || /\d\s*k\b/.test(s)) return n * 1e3;
  if (isRent) return n;       // rent: a bare number is rupees/month, as-is
  if (n > 100000) return n;   // already in rupees
  return n * 1e5;             // bare number -> assume lakhs (typical for budgets)
}

function trimNum(x) {
  return x.toFixed(2).replace(/\.?0+$/, "");
}

// Indian digit grouping: 25000 -> ₹25,000, 150000 -> ₹1,50,000.
function inrGroup(rupees) {
  var s = String(Math.round(rupees));
  if (s.length <= 3) return "₹" + s;
  var last3 = s.slice(-3);
  var rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + rest + "," + last3;
}

function inr(rupees, isRent) {
  if (rupees == null) return "";
  if (isRent) return inrGroup(rupees);     // rent: plain grouped rupees/month
  if (rupees >= 1e7) return "₹" + trimNum(rupees / 1e7) + " Cr";
  if (rupees >= 1e5) return "₹" + trimNum(rupees / 1e5) + " L";
  return "₹" + Math.round(rupees);
}

// Pretty rupee string for the Budget column. Buy/invest: "₹70–80 L", "₹0.8–1.2
// Cr", "₹80 L". Rent: plain monthly amounts "₹25,000" / "₹20,000–25,000".
function formatBudget(minRaw, maxRaw, intent) {
  var isRent = String(intent || "").toLowerCase().indexOf("rent") !== -1;
  var lo = toRupees(minRaw, isRent), hi = toRupees(maxRaw, isRent);
  if (lo == null && hi == null) return "";
  if (lo != null && hi != null && lo !== hi) {
    var top = Math.max(lo, hi), bot = Math.min(lo, hi);
    if (isRent) return inrGroup(bot) + "–" + inrGroup(top).slice(1); // drop 2nd ₹
    var unit = top >= 1e7 ? 1e7 : (top >= 1e5 ? 1e5 : 1);
    var suf = top >= 1e7 ? " Cr" : (top >= 1e5 ? " L" : "");
    return "₹" + trimNum(bot / unit) + "–" + trimNum(top / unit) + suf;
  }
  return inr(hi != null ? hi : lo, isRent);
}

// Set the derived budget_display cell in a row array from its budget_min/max,
// using intent so rent budgets aren't mis-scaled into lakhs.
function applyBudgetDisplay(arr) {
  var di = KEYS.indexOf("budget_display");
  if (di === -1) return arr;
  arr[di] = formatBudget(
    arr[KEYS.indexOf("budget_min")],
    arr[KEYS.indexOf("budget_max")],
    arr[KEYS.indexOf("intent")]
  );
  return arr;
}

function upsertLead(lead) {
  if (!lead.phone) return { ok: false, reason: "missing phone" };
  var sheet = getSheet();
  var row = findRow(sheet, lead.phone);

  if (row === -1) {
    var fresh = KEYS.map(function (key) {
      if (key === "timestamp" || key === "last_updated") return now();
      return lead[key] != null ? lead[key] : "";
    });
    applyBudgetDisplay(fresh);
    sheet.appendRow(fresh);
    formatNewRow(sheet, sheet.getLastRow());
    return { ok: true, created: true };
  }

  var existing = sheet.getRange(row, 1, 1, KEYS.length).getValues()[0];
  var updated = KEYS.map(function (key, idx) {
    if (key === "last_updated") return now();
    if (key === "timestamp") return existing[idx] || now();
    if (lead[key] != null && lead[key] !== "") return lead[key];
    return existing[idx];
  });
  applyBudgetDisplay(updated);
  sheet.getRange(row, 1, 1, KEYS.length).setValues([updated]);
  return { ok: true, updated: true };
}

function updateLeadVisit(phone, datetime, eventId) {
  var sheet = getSheet();
  var row = findRow(sheet, phone);
  if (row === -1) return;
  sheet.getRange(row, colNum("visit_datetime")).setValue(datetime);
  sheet.getRange(row, colNum("visit_event_id")).setValue(eventId);
  sheet.getRange(row, colNum("stage")).setValue("booked");
  sheet.getRange(row, colNum("last_updated")).setValue(now());
}

// Clear a lead's visit fields and step the stage back to qualified, so a
// cancelled lead returns to the bookable pipeline rather than reading "booked".
function clearLeadVisit(phone) {
  var sheet = getSheet();
  var row = findRow(sheet, phone);
  if (row === -1) return;
  sheet.getRange(row, colNum("visit_datetime")).setValue("");
  sheet.getRange(row, colNum("visit_event_id")).setValue("");
  sheet.getRange(row, colNum("stage")).setValue("qualified");
  sheet.getRange(row, colNum("last_updated")).setValue(now());
}

/* ---------------- Admin (delete + formatting) ---------------- */

// ADMIN ONLY. Delete a lead row entirely and remove its Calendar event. Never
// exposed as an agent tool — only the operator can trigger it (secret-gated).
function deleteLead(lead) {
  if (!lead.phone) return { ok: false, reason: "missing phone" };
  var sheet = getSheet();
  var row = findRow(sheet, lead.phone);
  if (row === -1) return { ok: false, reason: "no lead found for this phone" };

  var eventId = sheet.getRange(row, colNum("visit_event_id")).getValue();
  if (eventId) {
    try {
      var ev = getCalendar().getEventById(String(eventId));
      if (ev) ev.deleteEvent();
    } catch (e) {
      // event may already be gone; still delete the row
    }
  }
  sheet.deleteRow(row);
  return { ok: true, deleted: true, removed_event: !!eventId };
}

// ADMIN ONLY. (Re)apply the modern formatting to an existing sheet and drop the
// legacy "Visits" tab if it survives from an older version. Idempotent.
function formatSheetAction() {
  var sheet = getSheet();
  formatSheet(sheet);
  try {
    var ss = SpreadsheetApp.openById(prop("SHEET_ID"));
    var old = ss.getSheetByName("Visits");
    if (old) ss.deleteSheet(old);
  } catch (e) {}
  return { ok: true, formatted: true };
}

// ADMIN ONLY. Wipe ALL lead rows (keeps the formatted header). Useful to clear
// test data or reset between prospect demos. Does NOT touch Calendar events.
function resetSheet() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
  formatSheet(sheet);
  return { ok: true, reset: true, removed_rows: Math.max(last - 1, 0) };
}

// Apply header style, frozen panes, widths, hidden technical columns, row
// banding, and status colour-coding. Safe to run repeatedly.
function formatSheet(sheet) {
  var n = COLUMNS.length;

  // Header row.
  var header = sheet.getRange(1, 1, 1, n);
  header
    .setValues([LABELS])
    .setFontWeight("bold")
    .setFontColor("#ffffff")
    .setBackground("#1f3a5f")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(1, 34);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2); // keep Name + Phone visible while scrolling right

  // Column widths + hide technical columns.
  for (var i = 0; i < COLUMNS.length; i++) {
    sheet.setColumnWidth(i + 1, COLUMNS[i].w);
    if (COLUMNS[i].hidden) sheet.hideColumns(i + 1);
    else sheet.showColumns(i + 1);
  }

  var maxRows = sheet.getMaxRows();

  // Alternating row banding for readability (remove any existing first).
  sheet.getBandings().forEach(function (b) { b.remove(); });
  if (maxRows > 1) {
    sheet
      .getRange(2, 1, maxRows - 1, n)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  }

  // Colour-code the Status column so the pipeline is readable at a glance.
  var statusCol = colNum("stage");
  var statusRange = sheet.getRange(2, statusCol, Math.max(maxRows - 1, 1), 1);
  var palette = [
    { v: "new",        bg: "#e8eaed", fg: "#3c4043" },
    { v: "qualifying", bg: "#d2e3fc", fg: "#174ea6" },
    { v: "qualified",  bg: "#fef7cd", fg: "#7a5900" },
    { v: "booked",     bg: "#ceead6", fg: "#0d652d" },
    { v: "lost",       bg: "#fad2cf", fg: "#a50e0e" },
  ];
  var rules = sheet.getConditionalFormatRules().filter(function (r) {
    // Drop only our previous status rules (those scoped to the status column).
    var ranges = r.getRanges();
    return !(ranges.length === 1 && ranges[0].getColumn() === statusCol);
  });
  palette.forEach(function (p) {
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo(p.v)
        .setBackground(p.bg)
        .setFontColor(p.fg)
        .setRanges([statusRange])
        .build()
    );
  });
  sheet.setConditionalFormatRules(rules);
}

// Light per-row touch on append so new rows pick up alignment without a full
// reformat. Banding/conditional formatting already cover colour.
function formatNewRow(sheet, row) {
  sheet.getRange(row, colNum("phone")).setNumberFormat("@"); // keep phone as text
}

/* ---------------- Calendar ---------------- */

function getCalendar() {
  var id = prop("CALENDAR_ID", "primary");
  return id === "primary"
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(id);
}

// Build a clickable Google Calendar link for an event. CalendarApp events have
// no getHtmlLink(), so construct the standard event-view URL from the base64
// "eid" — no advanced service required.
function eventLinkFor(cal, event) {
  try {
    var shortId = event.getId().split("@")[0];
    var eid = Utilities.base64Encode(shortId + " " + cal.getId()).replace(/=+$/, "");
    return "https://www.google.com/calendar/event?eid=" + eid;
  } catch (e) {
    return "";
  }
}

function parseHours() {
  var hours = prop("BUSINESS_HOURS", "10:00-19:00").split("-");
  return {
    startH: parseInt(hours[0].split(":")[0], 10),
    startM: parseInt(hours[0].split(":")[1], 10),
    endH: parseInt(hours[1].split(":")[0], 10),
    endM: parseInt(hours[1].split(":")[1], 10),
  };
}

function isWorkingDay(date) {
  var days = prop("WORKING_DAYS", "Mon,Tue,Wed,Thu,Fri,Sat").split(",");
  var name = Utilities.formatDate(date, TZ, "EEE");
  return days.indexOf(name) !== -1;
}

// Returns free slots inside business hours for the date, excluding existing
// events, in VISIT_DURATION_MIN blocks.
function getSlots(dateStr) {
  if (!dateStr) return { ok: false, reason: "missing date" };
  var duration = parseInt(prop("VISIT_DURATION_MIN", "45"), 10);
  var h = parseHours();

  var parts = dateStr.split("-");
  var dayStart = new Date(parts[0], parts[1] - 1, parts[2], h.startH, h.startM, 0);
  var dayEnd = new Date(parts[0], parts[1] - 1, parts[2], h.endH, h.endM, 0);

  if (!isWorkingDay(dayStart)) {
    return { ok: true, date: dateStr, slots: [], reason: "non-working day" };
  }

  var cal = getCalendar();
  var events = cal.getEvents(dayStart, dayEnd);

  var slots = [];
  var nowTs = new Date().getTime();
  var cursor = new Date(dayStart.getTime());

  while (cursor.getTime() + duration * 60000 <= dayEnd.getTime()) {
    var slotStart = new Date(cursor.getTime());
    var slotEnd = new Date(cursor.getTime() + duration * 60000);

    if (slotStart.getTime() > nowTs) {
      var busy = false;
      for (var i = 0; i < events.length; i++) {
        if (
          slotStart.getTime() < events[i].getEndTime().getTime() &&
          slotEnd.getTime() > events[i].getStartTime().getTime()
        ) {
          busy = true;
          break;
        }
      }
      if (!busy) {
        slots.push({
          start: Utilities.formatDate(slotStart, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
          label: Utilities.formatDate(slotStart, TZ, "EEE d MMM, h:mm a"),
        });
      }
    }
    cursor = new Date(cursor.getTime() + duration * 60000);
  }

  return { ok: true, date: dateStr, slots: slots };
}

function bookAppointment(booking) {
  if (!booking.datetime) return { ok: false, reason: "missing datetime" };
  if (!booking.phone) return { ok: false, reason: "missing phone" };

  var start = new Date(booking.datetime);
  if (isNaN(start.getTime())) return { ok: false, reason: "invalid datetime" };
  if (start.getTime() < new Date().getTime()) {
    return { ok: false, reason: "cannot book a past time" };
  }

  var duration = parseInt(prop("VISIT_DURATION_MIN", "45"), 10);
  var end = new Date(start.getTime() + duration * 60000);

  // Serialize the check-then-create across concurrent requests so two leads
  // can't both pass the clash check for the same slot.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { ok: false, reason: "busy, please retry" };
  }
  try {
    return createBooking(booking, start, end);
  } finally {
    lock.releaseLock();
  }
}

function createBooking(booking, start, end) {
  var cal = getCalendar();

  // Guard against double-booking (cross-lead). Same-lead dedupe is handled in
  // the Node tool layer, which is reliable even when this read lags writes.
  var clashes = cal.getEvents(start, end);
  if (clashes.length > 0) {
    return { ok: false, reason: "slot just got taken", taken: true };
  }

  // Validate Sheet access BEFORE creating the event, so a bad SHEET_ID or
  // permissions error can never leave an orphan Calendar event.
  var sheet = getSheet();

  var lead = booking.lead || {};
  var name = booking.name || lead.name || "Lead";
  var title = "Site Visit — " + name + " (" + booking.phone + ")";
  var desc =
    "Intent: " + (lead.intent || "") +
    "\nConfig: " + (lead.configuration || "") +
    "\nArea: " + (lead.area_locality || "") +
    "\nBudget: " + (lead.budget_min || "") + " - " + (lead.budget_max || "") +
    "\nPhone: " + booking.phone;

  var event = cal.createEvent(title, start, end, { description: desc });
  var eventId = event.getId();
  var eventLink = eventLinkFor(cal, event);

  // Sync the lead row. If the write fails, roll back the event so the lead is
  // never told "booked" without a CRM record.
  try {
    updateLeadVisit(
      booking.phone,
      Utilities.formatDate(start, TZ, "yyyy-MM-dd HH:mm"),
      eventId
    );
  } catch (err) {
    try {
      event.deleteEvent();
    } catch (e) {
      // best-effort rollback; surface the original failure below
    }
    return { ok: false, reason: "sheet write failed, booking rolled back: " + err.message };
  }

  return {
    ok: true,
    event_id: eventId,
    event_link: eventLink,
    when: Utilities.formatDate(start, TZ, "EEE d MMM yyyy, h:mm a"),
  };
}

// Cancel a lead's existing site visit: delete the Calendar event and clear the
// lead's visit fields. Looks the event up from the lead row when no event_id is
// supplied.
function cancelAppointment(booking) {
  if (!booking.phone) return { ok: false, reason: "missing phone" };

  var eventId = booking.event_id;
  if (!eventId) {
    var sheet = getSheet();
    var row = findRow(sheet, booking.phone);
    if (row !== -1) eventId = sheet.getRange(row, colNum("visit_event_id")).getValue();
  }
  if (!eventId) return { ok: false, reason: "no booking found for this lead" };

  var cal = getCalendar();
  try {
    var ev = cal.getEventById(String(eventId));
    if (ev) ev.deleteEvent();
  } catch (err) {
    // Event may already be gone; still clean up the sheet below.
  }

  clearLeadVisit(booking.phone);
  return { ok: true, cancelled: true };
}

/* ---------------- Availability blocks (ADMIN ONLY) ---------------- */

// ADMIN ONLY. Mark the owner unavailable by creating a Calendar block event.
// Because getSlots excludes overlapping events, this removes the blocked slots
// from what the agent offers. One-off blocks only (no recurrence for now).
//   block.date  "yyyy-MM-dd"   (required)
//   block.allDay bool          (whole day off)
//   block.start "HH:mm"        (required unless allDay)
//   block.end   "HH:mm"        (required unless allDay)
//   block.reason string        (optional, shown in the event title)
function blockTime(block) {
  if (!block.date) return { ok: false, reason: "missing date" };
  var parts = String(block.date).split("-");
  if (parts.length !== 3) return { ok: false, reason: "bad date (want yyyy-MM-dd)" };
  var y = parseInt(parts[0], 10), mo = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);

  var cal = getCalendar();
  var reason = block.reason ? String(block.reason).trim() : "";
  var title = reason ? BLOCK_PREFIX + " " + reason : BLOCK_PREFIX;

  var event;
  if (block.allDay) {
    event = cal.createAllDayEvent(title, new Date(y, mo, d));
  } else {
    if (!block.start || !block.end) {
      return { ok: false, reason: "missing start/end time" };
    }
    var s = String(block.start).split(":"), e = String(block.end).split(":");
    var start = new Date(y, mo, d, parseInt(s[0], 10), parseInt(s[1] || 0, 10), 0);
    var end = new Date(y, mo, d, parseInt(e[0], 10), parseInt(e[1] || 0, 10), 0);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return { ok: false, reason: "invalid time" };
    }
    if (end.getTime() <= start.getTime()) {
      return { ok: false, reason: "end must be after start" };
    }
    event = cal.createEvent(title, start, end);
  }

  return { ok: true, id: event.getId(), label: blockLabel(event) };
}

// ADMIN ONLY. List upcoming availability blocks within the next `days` days
// (default 30), most useful first.
function listBlocks(days) {
  var n = parseInt(days, 10);
  if (isNaN(n) || n <= 0) n = 30;
  var cal = getCalendar();
  var from = new Date();
  var to = new Date(from.getTime() + n * 24 * 60 * 60000);
  var events = cal.getEvents(from, to);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.getTitle().indexOf(BLOCK_PREFIX) !== 0) continue;
    var allDay = ev.isAllDayEvent();
    out.push({
      id: ev.getId(),
      allDay: allDay,
      reason: ev.getTitle().slice(BLOCK_PREFIX.length).trim(),
      start: Utilities.formatDate(ev.getStartTime(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      end: Utilities.formatDate(ev.getEndTime(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      label: blockLabel(ev),
    });
  }
  return { ok: true, blocks: out };
}

// ADMIN ONLY. Delete a block by event id. Verifies the BLOCK_PREFIX first so a
// real site-visit event can never be removed through this path.
function removeBlock(id) {
  if (!id) return { ok: false, reason: "missing id" };
  var cal = getCalendar();
  var ev;
  try {
    ev = cal.getEventById(String(id));
  } catch (e) {
    return { ok: false, reason: "event not found" };
  }
  if (!ev) return { ok: false, reason: "event not found" };
  if (ev.getTitle().indexOf(BLOCK_PREFIX) !== 0) {
    return { ok: false, reason: "not a block event" };
  }
  ev.deleteEvent();
  return { ok: true, removed: true };
}

// Human-readable label for a block event (used in the dashboard list).
function blockLabel(ev) {
  if (ev.isAllDayEvent()) {
    return Utilities.formatDate(ev.getAllDayStartDate(), TZ, "EEE d MMM") + " — all day";
  }
  return Utilities.formatDate(ev.getStartTime(), TZ, "EEE d MMM, h:mm a") +
    " – " + Utilities.formatDate(ev.getEndTime(), TZ, "h:mm a");
}
