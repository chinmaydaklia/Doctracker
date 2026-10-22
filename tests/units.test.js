import { test } from "node:test";
import assert from "node:assert/strict";
import { toPaise, fmtINR, applyBp, pctToBp, rupeesStr } from "../js/money.js";
import { fmtDate, parseDMY, periodFor, fyOf, fyRange } from "../js/dates.js";
import { calcAgreement } from "../js/calc.js";
import { reportToCSV, parseCSV } from "../js/csv.js";
import { convertLegacy } from "../js/legacy.js";
import { setup, lines, R } from "./helpers.js";

test("money parsing and Indian formatting", () => {
  assert.equal(toPaise("1,250"), 125000);
  assert.equal(toPaise("₹ 300.5"), 30050);
  assert.equal(toPaise("0.1"), 10);
  assert.equal(toPaise("-5"), null);
  assert.equal(toPaise("-5", { allowNegative: true }), -500);
  assert.equal(toPaise("abc"), null);
  assert.equal(toPaise("1.234"), null);
  assert.equal(fmtINR(12345678), "₹1,23,456.78");
  assert.equal(fmtINR(1000000000), "₹1,00,00,000");
  assert.equal(fmtINR(-5000), "−₹50");
  assert.equal(rupeesStr(-5), "-0.05");
  // 0.1 + 0.2 style float errors cannot occur
  assert.equal(toPaise("0.1") + toPaise("0.2"), toPaise("0.3"));
});

test("percentages in basis points round half away from zero", () => {
  assert.equal(pctToBp("30"), 3000);
  assert.equal(pctToBp("12.5"), 1250);
  assert.equal(pctToBp("101"), null);
  assert.equal(applyBp(R(90000), 3000), R(27000));
  assert.equal(applyBp(5, 5000), 3); // 2.5 paise -> 3
  assert.equal(applyBp(-5, 5000), -3);
  assert.equal(applyBp(1e13, 3333), 3333e9);
});

test("dates are DD-MM-YYYY and periods/financial years are right", () => {
  assert.equal(fmtDate("2026-10-21"), "21-10-2026");
  assert.equal(parseDMY("1/4/2026"), "2026-04-01");
  assert.equal(parseDMY("31-02-2026"), null);
  assert.deepEqual(periodFor("monthly", "2026-02-14"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodFor("fortnightly", "2026-02-16"), { from: "2026-02-16", to: "2026-02-28" });
  assert.deepEqual(periodFor("weekly", "2026-10-21"), { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(fyOf("2026-03-31"), 2025);
  assert.equal(fyOf("2026-04-01"), 2026);
  assert.deepEqual(fyRange(2026), { from: "2026-04-01", to: "2027-03-31" });
});

test("all seven agreement types", () => {
  const base = R(100000);
  const a = (type, extra = {}) => calcAgreement({ type, pctBp: 3000, salaryPaise: R(40000), minPaise: R(20000), ...extra }, base, R(12345)).amount;
  assert.equal(a("fixed"), R(40000));
  assert.equal(a("pct"), R(30000));
  assert.equal(a("min"), R(20000));
  assert.equal(a("max_min_pct"), R(30000));
  assert.equal(calcAgreement({ type: "max_min_pct", pctBp: 3000, minPaise: R(20000) }, R(50000)).amount, R(20000));
  assert.equal(a("min_plus_pct"), R(50000));
  assert.equal(a("salary_plus_pct"), R(70000));
  assert.equal(a("manual"), R(12345));
});

test("agreement validation needs the fields its type uses", async () => {
  const { store, hosp } = await setup();
  await assert.rejects(store.saveAgreement({ payerId: hosp.id, effectiveFrom: "2026-01-01", type: "pct", pctBp: 3000 }), /percentage applies/);
  await assert.rejects(store.saveAgreement({ payerId: hosp.id, effectiveFrom: "2026-01-01", type: "max_min_pct", pctBp: 3000, base: "gross" }), /minimum/);
});

test("CSV is Excel-safe and round-trips", () => {
  const csv = reportToCSV({
    columns: [{ key: "d", label: "Date", type: "date" }, { key: "n", label: "Note" }, { key: "a", label: "Amount", type: "money" }],
    rows: [{ d: "2026-10-21", n: 'He said "hi", ok', a: 30050 }, { d: "2026-10-22", n: "=cmd()", a: -100 }],
    totals: { a: 29950 },
  });
  assert.ok(csv.startsWith("﻿"));
  const rows = parseCSV(csv);
  assert.deepEqual(rows[0], ["Date", "Note", "Amount (₹)"]);
  assert.deepEqual(rows[1], ["21-10-2026", 'He said "hi", ok', "300.50"]);
  assert.deepEqual(rows[2], ["22-10-2026", "'=cmd()", "-1.00"]);
  assert.deepEqual(rows[3], ["Total", "", "299.50"]);
});

test("duplicate session warning, summary validation, hospital collector rules", async () => {
  const { store, clinic, ward } = await setup();
  const d = "2026-03-10";
  await store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, d, { new: 1 }) });
  const dup = await store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, d, { new: 1 }) });
  assert.equal(dup.needsConfirm, true);
  const ok = await store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, d, { new: 1 }) }, { allowDuplicate: true });
  assert.ok(ok.session);
  await assert.rejects(store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "evening", lines: lines(store, clinic.id, d, { new: 1 }), collections: { cash: R(400) } }), /exceed net/);
  await assert.rejects(store.saveSummarySession({ date: d, locationId: ward.id, sessionName: "morning", lines: lines(store, ward.id, d, { new: 1 }), collections: { cash: R(300) } }), /hospital collects/i);
  // manual total when exact fees are unknown
  const m = await store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "camp", lines: lines(store, clinic.id, d, { new: 12 }), grossOverridePaise: R(2000), discountPaise: R(200), collections: { cash: R(1500) } });
  const f = store.ledger.sessionFin.get(m.session.id).eff;
  assert.deepEqual([f.visits, f.gross, f.net, f.paid, f.outstanding], [12, R(2000), R(1800), R(1500), R(300)]);
  // editing the summary replaces (not adds) its collections
  await store.saveSummarySession({ id: m.session.id, date: d, locationId: clinic.id, sessionName: "camp", lines: lines(store, clinic.id, d, { new: 12 }), grossOverridePaise: R(2000), discountPaise: R(200), collections: { cash: R(1000), upi: R(800) } });
  assert.equal(store.ledger.sessionFin.get(m.session.id).eff.paid, R(1800));
});

test("fee override needs a reason; audit log has no patient names", async () => {
  const { store, clinic } = await setup();
  await assert.rejects(store.addVisit({ date: "2026-03-10", locationId: clinic.id, sessionName: "morning", category: "new", feePaise: R(250) }), /reason/);
  const { visit } = await store.addVisit({ date: "2026-03-10", locationId: clinic.id, sessionName: "morning", category: "new", feePaise: R(250), overrideReason: "Known patient", patientName: "Ramesh Kumar", patientId: "pid-secret-x" });
  await store.updateVisit(visit.id, { remarks: "x" }, "typo");
  const log = JSON.stringify(store.data.audit);
  assert.ok(!log.includes("Ramesh"));
  assert.ok(!log.includes("pid-secret-x"));
  assert.ok(store.data.audit.every((a) => a.user && a.at));
});

test("later payment on an unreconciled summary session still counts as collection", async () => {
  const { store, clinic } = await setup();
  const d = "2026-03-10";
  const { session } = await store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, d, { new: 2 }), collections: { cash: R(300) } });
  await store.recordPatientPayment({ date: "2026-03-15", method: "cash", amountPaise: R(300), allocations: [{ targetType: "session", targetId: session.id, amountPaise: R(300) }] });
  const f = store.ledger.sessionFin.get(session.id).eff;
  assert.equal(f.paid, R(600));
  assert.equal(f.outstanding, 0);
});

test("legacy tracker data converts to summary sessions without double counting", () => {
  const legacy = {
    hospitals: ["City Hospital"],
    entries: [
      { id: "a", date: "2026-09-01", hosp: "City Hospital", rt: "both", morning: { icu: { c: 2, r: 400 }, pvt: { c: 1, r: 300 }, ward: { c: 0, r: 200 }, opd: { c: 5, r: 150, inc: true } }, evening: { icu: { c: 1, r: 400 }, pvt: { c: 0, r: 300 }, ward: { c: 0, r: 200 }, opd: { c: 0, r: 150, inc: true } }, procs: [{ name: "ECG", c: 2, r: 200 }], exps: [] },
      { id: "b", date: "2026-09-02", hosp: "City Hospital", rt: "morning", morning: { icu: { c: 0, r: 400 }, pvt: { c: 0, r: 300 }, ward: { c: 3, r: 200 }, opd: { c: 4, r: 150, inc: false } }, evening: { icu: { c: 9, r: 400 }, pvt: { c: 0, r: 300 }, ward: { c: 0, r: 200 }, opd: { c: 0, r: 150, inc: true } }, procs: [], exps: [] },
    ],
    payments: [{ id: "p", hosp: "City Hospital", month: "2026-09", exp: 50000, rec: 30000, notes: "" }],
    admissions: [{ id: "x", name: "Someone" }],
  };
  const out = convertLegacy(legacy, { now: 1, today: "2026-10-21" });
  const visitLines = out.sessions.flatMap((s) => s.summary.lines.filter((l) => l.isVisit));
  const procLines = out.sessions.flatMap((s) => s.summary.lines.filter((l) => !l.isVisit));
  assert.equal(visitLines.reduce((t, l) => t + l.count, 0), 2 + 1 + 5 + 1 + 3 + 4, "evening of a morning-only day is ignored");
  assert.equal(procLines.reduce((t, l) => t + l.count * l.feePaise, 0), R(400));
  assert.equal(out.settlements.length, 1);
  assert.equal(out.payments[0].amountPaise, R(30000));
  assert.equal(out.skippedAdmissions, 1);
});

test("service worker precaches every app file (offline start)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const files = [...readdirSync(new URL("../js", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => "js/" + f), ...readdirSync(new URL("../js/ui", import.meta.url)).map((f) => "js/ui/" + f), "css/app.css", "index.html", "manifest.webmanifest"];
  for (const f of files) assert.ok(sw.includes(`"./${f}"`), `sw.js is missing ${f}`);
});

test("imported legacy records are relationally valid and counted once", async () => {
  const { Store } = await import("../js/store.js");
  const { memoryAdapter } = await import("../js/db.js");
  const { checkRelationships } = await import("../js/backup.js");
  const { activityTotals, computeSettlement } = await import("../js/calc.js");
  const store = await Store.open(memoryAdapter());
  const legacy = { hospitals: ["City"], entries: [{ date: "2026-09-01", hosp: "City", rt: "both", morning: { icu: { c: 2, r: 400 }, pvt: { c: 0, r: 300 }, ward: { c: 0, r: 200 }, opd: { c: 0, r: 150 } }, evening: { icu: { c: 1, r: 400 }, pvt: { c: 0, r: 300 }, ward: { c: 0, r: 200 }, opd: { c: 0, r: 150 } } }], payments: [{ hosp: "City", month: "2026-09", exp: 5000, rec: 6000 }] };
  const { skippedAdmissions, expensesPaise, ...records } = convertLegacy(legacy, { now: 1, today: "2026-10-21" });
  await store.importRecords(records, "old tracker test");
  assert.deepEqual(checkRelationships(store.data), []);
  assert.equal(activityTotals(store.ledger, {}).visits, 3);
  assert.equal(activityTotals(store.ledger, {}).gross, R(1200));
  const v = computeSettlement(store.data, store.ledger, store.data.settlements[0], "2026-10-21");
  assert.equal(v.calc.total, R(5000));
  assert.equal(v.balance, 0);
});
