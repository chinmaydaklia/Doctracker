// Example configuration and demo data. Demo data is only ever written to the separate
// demo database (doctracker-demo), never to the real records.

import { exampleLocations, defaultCategories } from "./model.js";
import { today, addDays, monthRange, addMonths } from "./dates.js";

// Example locations and hospitals (configuration only, no records).
export async function seedExampleLocations(store, effectiveFrom = "2020-01-01") {
  const ex = exampleLocations();
  const payerIds = {};
  for (const p of ex.payers) {
    const existing = store.data.payers.find((x) => x.name === p.name);
    payerIds[p.key] = existing ? existing.id : (await store.savePayer({ name: p.name })).id;
  }
  let i = 0;
  for (const l of ex.locations) {
    if (store.data.locations.some((x) => x.name === l.name)) continue;
    await store.saveLocation(
      { name: l.name, kind: l.kind, arrangement: l.arrangement, payerId: l.payer ? payerIds[l.payer] : null, sortOrder: i++ },
      { effectiveFrom, categories: defaultCategories(l.fees[0], l.fees[1]) },
    );
  }
  return payerIds;
}

// Deterministic pseudo-random so demo data looks the same each time.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export async function seedDemo(store, { days = 40 } = {}) {
  const t = today();
  const start = addDays(t, -days);
  const payerIds = await seedExampleLocations(store, addDays(start, -400));
  const R = (x) => x * 100;
  const loc = (name) => store.data.locations.find((l) => l.name === name);
  const rand = rng(42);
  const pick = (n) => Math.floor(rand() * n);

  await store.saveAgreement({ payerId: payerIds.A, effectiveFrom: addDays(start, -400), type: "max_min_pct", minPaise: R(20000), pctBp: 3000, base: "gross", frequency: "monthly", dueAfterDays: 10, notes: "Demo agreement" });
  await store.saveAgreement({ payerId: payerIds.B, effectiveFrom: addDays(start, -400), type: "salary_plus_pct", salaryPaise: R(15000), pctBp: 2000, base: "net", frequency: "monthly", dueAfterDays: 7, notes: "Demo agreement" });

  const ward = ["Hospital A — ICU", "Hospital A — Private ward", "Hospital A — General ward"];
  for (let d = 0; d <= days; d++) {
    const date = addDays(start, d);
    const dow = new Date(date + "T00:00:00").getDay();
    if (dow === 0) continue;
    // Hospital A ward rounds: summary only, hospital collects.
    for (const name of ward) {
      const l = loc(name);
      const rate = store.currentRate(l.id, date);
      const n = 2 + pick(6);
      await store.saveSummarySession({ date, locationId: l.id, sessionName: "morning", lines: rate.categories.map((c) => ({ ...c, count: c.key === "new" ? Math.ceil(n / 3) : c.key === "followup" ? n - Math.ceil(n / 3) : 0 })) }, { allowDuplicate: true });
    }
    // Own clinic evening: individual entries, direct payment, some unpaid.
    const clinic = loc("Own clinic");
    const nc = 4 + pick(8);
    for (let i = 0; i < nc; i++) {
      const fu = rand() < 0.45;
      const r = rand();
      const fee = fu ? R(200) : R(400);
      const discount = r < 0.08 ? R(100) : 0;
      const net = fee - discount;
      const paid = r < 0.12 ? 0 : r < 0.2 ? R(200) : net;
      await store.addVisit({
        date, locationId: clinic.id, sessionName: "evening", category: fu ? "followup" : "new", patientId: "D" + (100 + pick(60)),
        discountPaise: discount, discountReason: discount ? "Senior citizen" : "",
        payment: paid ? { amountPaise: Math.min(paid, net), method: rand() < 0.6 ? "upi" : "cash", date } : null,
      }, { allowDuplicate: true });
    }
    // Village OPD twice a week: summary with collections.
    if (dow === 2 || dow === 5) {
      const v = loc(dow === 2 ? "Village OPD 1" : "Village OPD 2");
      const rate = store.currentRate(v.id, date);
      const nn = 8 + pick(10);
      const nf = 4 + pick(8);
      const gross = nn * rate.categories[0].feePaise + nf * rate.categories[1].feePaise;
      const waive = R(100 * pick(3));
      await store.saveSummarySession({ date, locationId: v.id, sessionName: "afternoon", lines: rate.categories.map((c) => ({ ...c, count: c.key === "new" ? nn : nf })), discountPaise: waive, collections: { cash: gross - waive - R(100), upi: 0 }, remarks: "Demo village OPD" }, { allowDuplicate: true });
    }
    // Hospital B OPD (mixed): hospital collects.
    if (dow === 1 || dow === 4) {
      const b = loc("Hospital B — OPD");
      const rate = store.currentRate(b.id, date);
      await store.saveSummarySession({ date, locationId: b.id, sessionName: "morning", collector: "hospital", lines: rate.categories.map((c) => ({ ...c, count: c.key === "new" ? 6 + pick(6) : 5 + pick(5) })) }, { allowDuplicate: true });
    }
  }

  // A summary session with individual records that do not match (needs reconciliation).
  const opd = loc("Hospital A — OPD");
  const dRecon = addDays(t, -1);
  const { session } = await store.saveSummarySession({ date: dRecon, locationId: opd.id, sessionName: "evening", mode: "summary_recon", collector: "hospital", lines: store.currentRate(opd.id, dRecon).categories.map((c) => ({ ...c, count: c.key === "new" ? 10 : 20 })) }, { allowDuplicate: true });
  for (let i = 0; i < 29; i++) await store.addVisit({ sessionId: session.id, category: i < 10 ? "new" : "followup" });

  // A later payment for an earlier clinic visit.
  const ledger = store.ledger;
  const unpaid = store.data.visits.find((v) => ledger.visitFin.get(v.id)?.outstanding > 0 && v.date < addDays(t, -5));
  if (unpaid) {
    const o = ledger.visitFin.get(unpaid.id).outstanding;
    await store.recordPatientPayment({ date: addDays(unpaid.date, 3), method: "upi", amountPaise: o, reference: "UPI-DEMO", allocations: [{ targetType: "visit", targetId: unpaid.id, amountPaise: o }] });
  }

  // Last month's settlements for both hospitals, one part paid.
  const lastM = addMonths(t.slice(0, 7), -1);
  const r = monthRange(lastM);
  if (r.from >= start || r.to >= start) {
    const sa = await store.saveSettlement({ payerId: payerIds.A, periodStart: r.from, periodEnd: r.to, notes: "Demo" });
    await store.finalizeSettlement(sa.id);
    const va = store.settlementView(sa.id);
    await store.addAdjustment({ targetType: "settlement", targetId: sa.id, type: "settlement", amountPaise: -Math.round(va.calc.total / 10), reason: "TDS 10% (demo)" });
    await store.recordHospitalPayment({ settlementId: sa.id, date: addDays(r.to, 8), method: "bank", amountPaise: Math.round(va.calc.total * 0.5), reference: "NEFT-DEMO-1" });
    const sb = await store.saveSettlement({ payerId: payerIds.B, periodStart: r.from, periodEnd: r.to, notes: "Demo" });
    const vb = store.settlementView(sb.id);
    if (vb.balance > 0) await store.recordHospitalPayment({ settlementId: sb.id, date: addDays(r.to, 5), method: "bank", amountPaise: vb.balance, reference: "NEFT-DEMO-2" });
  }
}
