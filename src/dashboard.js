// Pure aggregation for the dashboard. Takes raw Leads rows (as the Apps Script
// returns them) and produces every metric the UI renders. Booking info lives on
// the lead row (single-sheet model), so upcoming visits are derived from booked
// leads — there is no separate Visits source. Kept free of I/O so it can be
// unit-tested and changed without touching Apps Script.

const TZ = process.env.TIMEZONE || "Asia/Kolkata";

// Returns the YYYY-MM-DD calendar date of `d` in the business timezone.
function istDate(d) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Parse the loosely-formatted "yyyy-MM-dd HH:mm[:ss]" strings the sheet stores.
function parseSheetDate(v) {
  if (!v) return null;
  const s = String(v).trim().replace(" ", "T");
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Best-effort conversion of freeform budget text to a number in crore.
function budgetToCr(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase().replace(/,/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  if (/cr|crore/.test(s)) return n;
  if (/lak|lac/.test(s)) return n / 100;
  if (n > 100000) return n / 1e7; // raw rupees
  return n; // bare number — assume crore
}

function budgetBucket(cr) {
  if (cr == null) return "Unknown";
  if (cr < 0.5) return "< ₹50L";
  if (cr < 1) return "₹50L–1Cr";
  if (cr < 1.5) return "₹1–1.5Cr";
  if (cr < 2) return "₹1.5–2Cr";
  if (cr < 3) return "₹2–3Cr";
  return "₹3Cr+";
}

// Increment a key in a plain-object counter.
function bump(obj, key) {
  const k = key == null || key === "" ? "Unknown" : String(key).trim();
  obj[k] = (obj[k] || 0) + 1;
}

// Turn a counter object into a sorted [{label, value}] array (desc by value).
function toSorted(counter, limit) {
  const arr = Object.entries(counter)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  return limit ? arr.slice(0, limit) : arr;
}

const STAGES = ["new", "qualifying", "qualified", "booked", "lost"];

export function computeMetrics(leads = [], now = new Date()) {
  const today = istDate(now);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const byStage = {};
  STAGES.forEach((s) => (byStage[s] = 0));
  const byIntent = {};
  const byConfig = {};
  const byType = {};
  const byPossession = {};
  const byLocality = {};
  const byBudget = {};
  const bySource = {};
  const byLanguage = {};
  const byDay = {};

  let newToday = 0;
  let newThisWeek = 0;
  const hotLeads = [];

  for (const l of leads) {
    const stage = (l.stage || "new").toString().trim().toLowerCase();
    if (byStage[stage] == null) byStage[stage] = 0;
    byStage[stage] += 1;

    bump(byIntent, l.intent);
    bump(byConfig, l.configuration);
    bump(byType, l.property_type);
    bump(byPossession, l.possession);
    bump(bySource, l.source);
    bump(byLanguage, l.language);
    bump(byBudget, budgetBucket(budgetToCr(l.budget_max)));

    // Localities can be comma-separated; count each.
    if (l.area_locality) {
      String(l.area_locality)
        .split(/[,/]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((area) => bump(byLocality, area));
    }

    const ts = parseSheetDate(l.timestamp);
    if (ts) {
      const day = istDate(ts);
      byDay[day] = (byDay[day] || 0) + 1;
      if (day === today) newToday += 1;
      if (ts >= weekAgo) newThisWeek += 1;
    }

    // Hot lead: qualified but no visit booked yet.
    if (stage === "qualified" && !l.visit_datetime) {
      hotLeads.push({
        name: l.name || "—",
        phone: l.phone || "",
        intent: l.intent || "",
        configuration: l.configuration || "",
        area: l.area_locality || "",
        budget: l.budget_max || "",
        updated: l.last_updated || l.timestamp || "",
      });
    }
  }

  const totalLeads = leads.length;
  const booked = byStage.booked || 0;
  const qualifiedPlus = (byStage.qualified || 0) + booked;
  const bookingRate = qualifiedPlus ? Math.round((booked / qualifiedPlus) * 100) : 0;

  // Upcoming visits: derived from booked leads (single-sheet model), future
  // only, sorted ascending.
  const upcomingVisits = leads
    .filter((l) => l.visit_datetime)
    .map((l) => ({ ...l, _dt: parseSheetDate(l.visit_datetime) }))
    .filter((l) => l._dt && l._dt >= now)
    .sort((a, b) => a._dt - b._dt)
    .slice(0, 25)
    .map((l) => ({
      name: l.name || "—",
      phone: l.phone || "",
      datetime: l.visit_datetime || "",
      status: "booked",
    }));

  // Leads-over-time: last 30 days, chronological, zero-filled.
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const d = istDate(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    trend.push({ label: d, value: byDay[d] || 0 });
  }

  return {
    kpis: {
      totalLeads,
      newToday,
      newThisWeek,
      booked,
      bookingRate,
      hotLeads: hotLeads.length,
      upcoming: upcomingVisits.length,
    },
    funnel: STAGES.map((s) => ({ label: s, value: byStage[s] || 0 })),
    intent: toSorted(byIntent),
    configuration: toSorted(byConfig),
    propertyType: toSorted(byType),
    possession: toSorted(byPossession),
    localities: toSorted(byLocality, 10),
    budget: toSorted(byBudget),
    source: toSorted(bySource),
    language: toSorted(byLanguage),
    trend,
    upcomingVisits,
    hotLeads: hotLeads.slice(0, 25),
    // Every inquiry as a row the client can scan: who wants what area, budget,
    // buy/rent. Most recently active first. Uses the sheet's pre-formatted
    // budget_display (rent-aware) so rent and buy budgets read correctly.
    inquiries: leads
      .map((l) => ({
        name: l.name || "",
        phone: l.phone || "",
        intent: l.intent || "",
        configuration: l.configuration || "",
        propertyType: l.property_type || "",
        area: l.area_locality || "",
        budget: l.budget_display || "",
        stage: (l.stage || "new").toString().trim().toLowerCase(),
        updated: l.last_updated || l.timestamp || "",
        _ts: (parseSheetDate(l.last_updated) || parseSheetDate(l.timestamp) || new Date(0)).getTime(),
      }))
      .sort((a, b) => b._ts - a._ts)
      .map(({ _ts, ...rest }) => rest),
  };
}

export default { computeMetrics };
