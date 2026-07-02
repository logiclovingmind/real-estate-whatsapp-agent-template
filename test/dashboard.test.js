import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "../src/dashboard.js";

// Fixed "now" so date-relative metrics are deterministic. IST midday.
const NOW = new Date("2026-06-21T12:00:00+05:30");
const day = (d) => `2026-06-${String(d).padStart(2, "0")} 11:00:00`;

function lead(over = {}) {
  return {
    phone: "9100000000",
    name: "Test",
    stage: "new",
    timestamp: day(21),
    ...over,
  };
}

test("empty inputs produce zeroed metrics", () => {
  const m = computeMetrics([], NOW);
  assert.equal(m.kpis.totalLeads, 0);
  assert.equal(m.kpis.booked, 0);
  assert.equal(m.kpis.bookingRate, 0);
  assert.equal(m.trend.length, 30);
  assert.ok(m.trend.every((p) => p.value === 0));
  assert.deepEqual(m.upcomingVisits, []);
});

test("counts totals and new today/this week", () => {
  const leads = [
    lead({ phone: "1", timestamp: day(21) }), // today
    lead({ phone: "2", timestamp: day(20) }), // this week
    lead({ phone: "3", timestamp: day(1) }), // older
  ];
  const m = computeMetrics(leads, NOW);
  assert.equal(m.kpis.totalLeads, 3);
  assert.equal(m.kpis.newToday, 1);
  assert.equal(m.kpis.newThisWeek, 2);
});

test("funnel covers all stages and booking rate", () => {
  const leads = [
    lead({ phone: "1", stage: "qualified" }),
    lead({ phone: "2", stage: "qualified" }),
    lead({ phone: "3", stage: "booked" }),
    lead({ phone: "4", stage: "new" }),
  ];
  const m = computeMetrics(leads, NOW);
  const byLabel = Object.fromEntries(m.funnel.map((f) => [f.label, f.value]));
  assert.equal(byLabel.qualified, 2);
  assert.equal(byLabel.booked, 1);
  // booked / (qualified + booked) = 1/3 = 33%
  assert.equal(m.kpis.bookingRate, 33);
});

test("hot leads are qualified without a booked visit", () => {
  const leads = [
    lead({ phone: "1", stage: "qualified", name: "Hot", configuration: "2BHK" }),
    lead({ phone: "2", stage: "qualified", visit_datetime: day(25) }), // booked → not hot
    lead({ phone: "3", stage: "new" }),
  ];
  const m = computeMetrics(leads, NOW);
  assert.equal(m.kpis.hotLeads, 1);
  assert.equal(m.hotLeads[0].name, "Hot");
});

test("budget text is bucketed", () => {
  const leads = [
    lead({ phone: "1", budget_max: "90 lakh" }),
    lead({ phone: "2", budget_max: "1.2 cr" }),
    lead({ phone: "3", budget_max: "" }),
  ];
  const m = computeMetrics(leads, NOW);
  const b = Object.fromEntries(m.budget.map((x) => [x.label, x.value]));
  assert.equal(b["₹50L–1Cr"], 1);
  assert.equal(b["₹1–1.5Cr"], 1);
  assert.equal(b["Unknown"], 1);
});

test("comma-separated localities counted individually", () => {
  const leads = [lead({ phone: "1", area_locality: "Wakad, Baner" })];
  const m = computeMetrics(leads, NOW);
  const loc = Object.fromEntries(m.localities.map((x) => [x.label, x.value]));
  assert.equal(loc.Wakad, 1);
  assert.equal(loc.Baner, 1);
});

test("only future visits are upcoming, sorted ascending", () => {
  const leads = [
    lead({ phone: "1", name: "Past", stage: "booked", visit_datetime: "2026-06-20 11:00" }),
    lead({ phone: "2", name: "Later", stage: "booked", visit_datetime: "2026-06-25 15:00" }),
    lead({ phone: "3", name: "Sooner", stage: "booked", visit_datetime: "2026-06-22 10:00" }),
  ];
  const m = computeMetrics(leads, NOW);
  assert.equal(m.upcomingVisits.length, 2);
  assert.equal(m.upcomingVisits[0].name, "Sooner");
  assert.equal(m.upcomingVisits[1].name, "Later");
  assert.equal(m.kpis.upcoming, 2);
});

test("trend places today's leads on the last point", () => {
  const leads = [lead({ phone: "1", timestamp: day(21) })];
  const m = computeMetrics(leads, NOW);
  assert.equal(m.trend[29].label, "2026-06-21");
  assert.equal(m.trend[29].value, 1);
});
