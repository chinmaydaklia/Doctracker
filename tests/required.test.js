// The 14 acceptance tests from the specification, in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { setup, lines, R } from "./helpers.js";
import { activityTotals, collectionTotals } from "../js/calc.js";
import { dailyReport, monthlyReport, paymentReport } from "../js/reports.js";
import { buildBackup, verifyBackup, restoreBackup } from "../js/backup.js";
import { openIndexedDB, memoryAdapter } from "../js/db.js";
import { Store } from "../js/store.js";

const D1 = "2026-03-10";
const D2 = "2026-03-11";

async function oneVisit(store, loc, { fee, paid = 0, discount = 0, date = D1, patientId = "" } = {}) {
  const r = await store.addVisit({
    date, locationId: loc.id, sessionName: "morning", category: "new", patientId,
    feePaise: fee, overrideReason: fee !== undefined && fee !== R(300) ? "test" : "",
    discountPaise: discount, discountType: "waiver", discountReason: "test",
    payment: paid ? { amountPaise: paid, method: "cash", date } : null,
  });
  return r.visit;
}

test("1. Ten new at ₹300 + five follow-ups at ₹150 = 15 visits, ₹3,750 gross", async () => {
  const { store, clinic } = await setup();
  await store.saveSummarySession({ date: D1, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, D1, { new: 10, followup: 5 }) });
  const t = activityTotals(store.ledger, { from: D1, to: D1 });
  assert.equal(t.visits, 15);
  assert.equal(t.newCount, 10);
  assert.equal(t.followupCount, 5);
  assert.equal(t.gross, R(3750));

  // Same result from individual entries.
  const s2 = await setup();
  for (let i = 0; i < 10; i++) await s2.store.addVisit({ date: D1, locationId: s2.clinic.id, sessionName: "evening", category: "new" });
  for (let i = 0; i < 5; i++) await s2.store.addVisit({ date: D1, locationId: s2.clinic.id, sessionName: "evening", category: "followup" });
  const t2 = activityTotals(s2.store.ledger, {});
  assert.equal(t2.visits, 15);
  assert.equal(t2.gross, R(3750));
  assert.equal(s2.store.data.sessions.length, 1, "visits share one session");
});

test("2. ₹300 visit with ₹200 received leaves ₹100 outstanding", async () => {
  const { store, clinic } = await setup();
  const v = await oneVisit(store, clinic, { paid: R(200) });
  const f = store.ledger.visitFin.get(v.id);
  assert.equal(f.net, R(300));
  assert.equal(f.paid, R(200));
  assert.equal(f.outstanding, R(100));
  assert.equal(f.status, "partial");
});

test("3. A later ₹100 payment changes collections/outstanding, not patients or revenue", async () => {
  const { store, clinic } = await setup();
  const v = await oneVisit(store, clinic, { paid: R(200) });
  const before = activityTotals(store.ledger, {});
  await store.recordPatientPayment({ date: D2, method: "upi", amountPaise: R(100), allocations: [{ targetType: "visit", targetId: v.id, amountPaise: R(100) }] });
  const after = activityTotals(store.ledger, {});
  assert.deepEqual(after, before, "patient count and consultation revenue unchanged");
  assert.equal(activityTotals(store.ledger, { from: D2, to: D2 }).net, 0, "day 2 new consultation revenue is ₹0");
  assert.equal(collectionTotals(store.ledger, { from: D1, to: D1 }).patient, R(200));
  assert.equal(collectionTotals(store.ledger, { from: D2, to: D2 }).patient, R(100), "day 2 collection is ₹100");
  assert.equal(store.ledger.visitFin.get(v.id).outstanding, 0, "final outstanding is ₹0");
  // Over-allocation is rejected.
  await assert.rejects(
    store.recordPatientPayment({ date: D2, method: "cash", amountPaise: R(50), allocations: [{ targetType: "visit", targetId: v.id, amountPaise: R(50) }] }),
    /exceeds the outstanding/,
  );
});

test("4. A ₹50 waiver on a ₹300 fee gives ₹250 net", async () => {
  const { store, clinic } = await setup();
  const v = await oneVisit(store, clinic, { discount: R(50) });
  assert.equal(store.ledger.visitFin.get(v.id).net, R(250));
  // Also as a later, separate adjustment transaction.
  const v2 = await oneVisit(store, clinic, {});
  await store.addAdjustment({ targetType: "visit", targetId: v2.id, type: "waiver", amountPaise: R(50), reason: "staff family" });
  assert.equal(store.ledger.visitFin.get(v2.id).net, R(250));
  assert.equal(store.data.adjustments.length, 2);
});

test("5. An unpaid visit generates no collection", async () => {
  const { store, clinic } = await setup();
  const v = await oneVisit(store, clinic, {});
  assert.equal(collectionTotals(store.ledger, {}).patient, 0);
  assert.equal(store.ledger.visitFin.get(v.id).status, "unpaid");
  assert.equal(store.ledger.visitFin.get(v.id).outstanding, R(300));
});

test("6. Hospital settlement payment reduces the hospital balance only", async () => {
  const { store, hosp, ward } = await setup();
  await store.saveAgreement({ payerId: hosp.id, effectiveFrom: "2026-01-01", type: "max_min_pct", minPaise: R(20000), pctBp: 3000, base: "gross", frequency: "monthly", dueAfterDays: 10 });
  await store.saveSummarySession({ date: D1, locationId: ward.id, sessionName: "morning", lines: lines(store, ward.id, D1, { new: 300 }) }); // ₹90,000
  const st = await store.saveSettlement({ payerId: hosp.id, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
  let v = store.settlementView(st.id, "2026-04-01");
  assert.equal(v.calc.base, R(90000));
  assert.equal(v.calc.share, R(27000));
  assert.equal(v.calc.total, R(27000), "MAX(20,000, 30% of 90,000)");
  const beforeAct = activityTotals(store.ledger, {});
  const visitsBefore = store.data.visits.length;
  await store.recordHospitalPayment({ settlementId: st.id, date: "2026-04-08", method: "bank", amountPaise: R(20000), reference: "NEFT123" });
  v = store.settlementView(st.id, "2026-04-09");
  assert.equal(v.paid, R(20000));
  assert.equal(v.balance, R(7000));
  assert.equal(v.status, "partial");
  assert.deepEqual(activityTotals(store.ledger, {}), beforeAct, "no new consultation revenue");
  assert.equal(store.data.visits.length, visitsBefore, "no new visits");
  const c = collectionTotals(store.ledger, {});
  assert.equal(c.patient, 0, "not a patient collection");
  assert.equal(c.hospital, R(20000));
  // Patient outstanding is unaffected by hospital-collected sessions.
  assert.equal(store.ledger.sessionFin.get(store.data.sessions[0].id).eff.outstanding, 0);
  // Minimum guarantee when revenue is low; minimum-plus-percentage variant.
  await store.saveAgreement({ payerId: hosp.id, effectiveFrom: "2026-05-01", type: "min_plus_pct", minPaise: R(20000), pctBp: 3000, base: "gross", frequency: "monthly" });
  await store.saveSummarySession({ date: "2026-05-02", locationId: ward.id, sessionName: "morning", lines: lines(store, ward.id, "2026-05-02", { new: 10 }) });
  const may = await store.saveSettlement({ payerId: hosp.id, periodStart: "2026-05-01", periodEnd: "2026-05-31" });
  assert.equal(store.settlementView(may.id).calc.total, R(20000) + R(900));
});

test("7. Summary and individual records are not double-counted", async () => {
  const { store, clinic } = await setup();
  const { session } = await store.saveSummarySession({
    date: D1, locationId: clinic.id, sessionName: "morning", mode: "summary_recon",
    lines: lines(store, clinic.id, D1, { new: 2 }), collections: { cash: R(600) },
  });
  for (let i = 0; i < 2; i++) await store.addVisit({ sessionId: session.id, category: "new", payment: { amountPaise: R(300), method: "cash" } });
  let t = activityTotals(store.ledger, {});
  assert.equal(t.visits, 2);
  assert.equal(t.gross, R(600));
  assert.equal(collectionTotals(store.ledger, {}).patient, R(600));
  await store.reconcileSession(session.id, { source: "individual" });
  t = activityTotals(store.ledger, {});
  assert.equal(t.visits, 2);
  assert.equal(t.gross, R(600));
  assert.equal(collectionTotals(store.ledger, {}).patient, R(600), "summary collections superseded, not added");
  assert.equal(store.ledger.sessionFin.get(session.id).source, "individual");
});

test("8. A summary/individual discrepancy is flagged", async () => {
  const { store, clinic } = await setup();
  const { session } = await store.saveSummarySession({ date: D1, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, D1, { new: 30 }) });
  for (let i = 0; i < 29; i++) await store.addVisit({ sessionId: session.id, category: "new" });
  const f = store.ledger.sessionFin.get(session.id);
  assert.equal(f.needsRecon, true);
  assert.equal(store.get("sessions", session.id).status, "needs_recon");
  const visits = f.recon.items.find((i) => i.key === "visits");
  const gross = f.recon.items.find((i) => i.key === "gross");
  assert.deepEqual([visits.summary, visits.individual, visits.diff], [30, 29, -1]);
  assert.deepEqual([gross.summary, gross.individual, gross.diff], [R(9000), R(8700), -R(300)]);
  assert.equal(f.recon.matches, false);
  await assert.rejects(store.reconcileSession(session.id, { source: "individual" }), /reason/);
  await store.reconcileSession(session.id, { source: "summary", note: "One patient not written in register" });
  assert.equal(store.ledger.sessionFin.get(session.id).eff.visits, 30);
  assert.equal(store.ledger.sessionFin.get(session.id).needsRecon, false);
  await store.reopenSession(session.id, "Found the missing slip");
  assert.equal(store.ledger.sessionFin.get(session.id).needsRecon, true);
  assert.ok(store.data.audit.some((a) => a.action === "reopen" && a.entityId === session.id));
});

test("9. Changing a rate does not change past visits", async () => {
  const { store, clinic } = await setup();
  const v = await oneVisit(store, clinic, {});
  const rate = store.currentRate(clinic.id, D1);
  await store.updateRate(rate.id, { categories: rate.categories.map((c) => ({ ...c, feePaise: c.feePaise + R(100) })) }, "fee revision");
  await store.addRate({ locationId: clinic.id, effectiveFrom: "2026-04-01", categories: rate.categories.map((c) => ({ ...c, feePaise: R(500) })) });
  assert.equal(store.get("visits", v.id).feePaise, R(300));
  assert.equal(store.ledger.visitFin.get(v.id).gross, R(300));
  const later = await oneVisit(store, clinic, { date: "2026-04-02", fee: R(500) });
  assert.equal(later.feePaise, R(500));
  assert.equal(store.currentRate(clinic.id, "2026-03-31").categories[0].feePaise, R(400));
});

test("10. Two genuine consultations for the same patient are allowed", async () => {
  const { store, clinic } = await setup();
  await oneVisit(store, clinic, { patientId: "P-17" });
  const second = await store.addVisit({ date: D1, locationId: clinic.id, sessionName: "morning", category: "followup", patientId: "P-17" });
  assert.equal(second.needsConfirm, true, "warns, never auto-rejects");
  const ok = await store.addVisit({ date: D1, locationId: clinic.id, sessionName: "morning", category: "followup", patientId: "P-17" }, { allowDuplicate: true });
  assert.ok(ok.visit);
  await store.addVisit({ date: D1, locationId: clinic.id, sessionName: "evening", category: "followup", patientId: "P-17" });
  assert.equal(activityTotals(store.ledger, {}).visits, 3);
});

test("11. Refunds and adjustments reconcile", async () => {
  const { store, clinic } = await setup();
  const v = await oneVisit(store, clinic, { paid: R(300) });
  await store.addAdjustment({ targetType: "visit", targetId: v.id, type: "discount", amountPaise: R(100), reason: "x" }).then(
    () => assert.fail("discount below amount paid must need a refund first"),
    (e) => assert.match(e.message, /refund/),
  );
  await store.recordRefund({ date: D2, method: "cash", amountPaise: R(100), targetType: "visit", targetId: v.id, reason: "Overcharged" });
  await store.addAdjustment({ targetType: "visit", targetId: v.id, type: "discount", amountPaise: R(100), reason: "Senior citizen" });
  let f = store.ledger.visitFin.get(v.id);
  assert.equal(f.net, R(200));
  assert.equal(f.paid, R(200));
  assert.equal(f.outstanding, 0);
  assert.equal(collectionTotals(store.ledger, { from: D1, to: D1 }).patient, R(300));
  assert.equal(collectionTotals(store.ledger, { from: D2, to: D2 }).patient, -R(100));
  // Cancellation: visit no longer counts; payment awaits refund.
  const v2 = await oneVisit(store, clinic, { paid: R(300) });
  await store.cancelVisit(v2.id, "Patient left before consultation");
  f = store.ledger.visitFin.get(v2.id);
  assert.equal(f.status, "refund_due");
  assert.equal(activityTotals(store.ledger, {}).visits, 1);
  await store.recordRefund({ date: D2, method: "cash", amountPaise: R(300), targetType: "visit", targetId: v2.id, reason: "Cancelled" });
  assert.equal(store.ledger.visitFin.get(v2.id).outstanding, 0);
  // Mistaken payment: void reverses it, record remains.
  const v3 = await oneVisit(store, clinic, {});
  const p = await store.recordPatientPayment({ date: D1, method: "upi", amountPaise: R(300), allocations: [{ targetType: "visit", targetId: v3.id, amountPaise: R(300) }] });
  await store.voidPayment(p.id, "Wrong patient");
  assert.equal(store.ledger.visitFin.get(v3.id).outstanding, R(300));
  assert.ok(store.get("payments", p.id).voided);
  // Settlement adjustment changes the amount payable, not revenue.
  const h = await setup();
  await h.store.saveAgreement({ payerId: h.hosp.id, effectiveFrom: "2026-01-01", type: "fixed", salaryPaise: R(50000) });
  const st = await h.store.saveSettlement({ payerId: h.hosp.id, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
  await h.store.addAdjustment({ targetType: "settlement", targetId: st.id, type: "settlement", amountPaise: -R(2000), reason: "TDS deducted" });
  await h.store.recordHospitalPayment({ settlementId: st.id, date: "2026-04-05", method: "bank", amountPaise: R(48000) });
  const sv = h.store.settlementView(st.id);
  assert.equal(sv.calc.total, R(48000));
  assert.equal(sv.balance, 0);
  assert.equal(sv.status, "paid");
});

test("12. Daily and monthly totals match the underlying transactions", async () => {
  const { store, clinic, ward } = await setup();
  const days = ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"];
  const vids = [];
  for (const d of days) {
    vids.push((await oneVisit(store, clinic, { date: d, paid: R(100) })).id);
    await store.saveSummarySession({ date: d, locationId: clinic.id, sessionName: "evening", lines: lines(store, clinic.id, d, { new: 3, followup: 2 }), collections: { cash: R(500), upi: R(400) } });
    await store.saveSummarySession({ date: d, locationId: ward.id, sessionName: "morning", lines: lines(store, ward.id, d, { new: 4 }) });
  }
  // February visit paid in March.
  await store.recordPatientPayment({ date: "2026-03-05", method: "cash", amountPaise: R(200), allocations: [{ targetType: "visit", targetId: vids[0], amountPaise: R(200) }] });
  const all = { from: "2026-02-01", to: "2026-03-31" };
  const act = activityTotals(store.ledger, all);
  const col = collectionTotals(store.ledger, all);
  const daily = dailyReport(store.ledger, all);
  assert.equal(daily.totals.patients, act.visits);
  assert.equal(daily.totals.gross, act.gross);
  assert.equal(daily.totals.net, act.net);
  assert.equal(daily.totals.collected, col.patient);
  const sumPayments = store.data.payments.filter((p) => !p.voided).reduce((t, p) => t + p.amountPaise, 0);
  assert.equal(col.patient, sumPayments);
  const monthly = monthlyReport(store.ledger, all, "2026-03-31");
  assert.equal(monthly.totals.patients, act.visits);
  assert.equal(monthly.totals.net, act.net);
  assert.equal(monthly.totals.collected, col.patient);
  const feb = monthly.rows.find((r) => r.ym === "2026-02");
  const mar = monthly.rows.find((r) => r.ym === "2026-03");
  assert.equal(feb.collected, 2 * (R(100) + R(900)), "Feb collections exclude the March payment");
  assert.equal(mar.collected, 2 * (R(100) + R(900)) + R(200));
  assert.equal(feb.net, 2 * (R(300) + R(1200) + R(1200)), "revenue stays in February");
  assert.equal(feb.outstanding, 2 * (R(200) + R(300)), "Feb month-end receivable");
  assert.equal(mar.outstanding, 4 * (R(200) + R(300)) - R(200));
  assert.equal(paymentReport(store.ledger, all, () => "").totals.amount, col.patient);
});

test("13. Export and restore preserve every record and relationship", async () => {
  const { store, clinic, hosp, ward } = await setup();
  const v = await oneVisit(store, clinic, { paid: R(200), discount: R(50) });
  await store.saveSummarySession({ date: D1, locationId: ward.id, sessionName: "morning", lines: lines(store, ward.id, D1, { new: 5 }) });
  await store.saveAgreement({ payerId: hosp.id, effectiveFrom: "2026-01-01", type: "pct", pctBp: 3000, base: "gross" });
  const st = await store.saveSettlement({ payerId: hosp.id, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
  await store.recordHospitalPayment({ settlementId: st.id, date: "2026-04-05", method: "bank", amountPaise: R(450) });
  const backup = await buildBackup(store.data);
  const json = JSON.stringify(backup);
  const check = await verifyBackup(JSON.parse(json));
  assert.equal(check.ok, true, check.errors.join("; "));

  const fresh = await Store.open(memoryAdapter());
  await restoreBackup(fresh, JSON.parse(json));
  for (const s of ["locations", "rates", "payers", "agreements", "sessions", "visits", "payments", "allocations", "adjustments", "settlements"]) {
    assert.deepEqual(
      [...fresh.data[s]].sort((a, b) => a.id.localeCompare(b.id)),
      [...store.data[s]].sort((a, b) => a.id.localeCompare(b.id)),
      s,
    );
  }
  assert.equal(fresh.ledger.visitFin.get(v.id).outstanding, R(50));
  assert.equal(fresh.settlementView(st.id).balance, 0);
  assert.deepEqual(activityTotals(fresh.ledger, {}), activityTotals(store.ledger, {}));

  const tampered = JSON.parse(json);
  tampered.stores.payments[0].amountPaise += 100;
  assert.equal((await verifyBackup(tampered)).ok, false, "tampering detected");
  const broken = JSON.parse(json);
  broken.stores.sessions = [];
  broken.counts.sessions = 0;
  const b = await verifyBackup(broken);
  assert.equal(b.ok, false);
  assert.ok(b.errors.some((e) => /missing session/.test(e)));
});

test("14. Entries persist after closing and reopening (IndexedDB)", async () => {
  const name = "persist-test-" + Math.random();
  const a1 = await openIndexedDB(name);
  const { store, clinic } = await setup(a1);
  const v = await oneVisit(store, clinic, { paid: R(200) });
  a1.close();
  const a2 = await openIndexedDB(name);
  const reopened = await Store.open(a2);
  assert.equal(reopened.get("visits", v.id).feePaise, R(300));
  assert.equal(reopened.ledger.visitFin.get(v.id).outstanding, R(100));
  assert.equal(reopened.data.audit.length, store.data.audit.length);
  a2.close();
});
