// Dashboard figures. Revenue, collections, receivables and personal earnings are
// separate measures and are never added to each other.

import { activityTotals, collectionTotals, patientReceivable, computeSettlement, agreementFor, eligibleRevenue, calcAgreement, settlementBase } from "./calc.js";
import { monthRange } from "./dates.js";

// Personal earnings expected for a month: net fees of sessions where patients pay me
// directly, plus each hospital's amount under its agreement. Settlement records that
// cover the month are used when they exist; otherwise the agreement is estimated for
// the calendar month (salary / minimum treated as monthly).
export function expectedEarnings(data, ledger, ym, asOf) {
  const { from, to } = monthRange(ym);
  const direct = activityTotals(ledger, { from, to }).directNet;
  const hospitals = [];
  for (const p of data.payers.filter((p) => p.active !== false)) {
    const sts = data.settlements.filter((s) => !s.voided && s.payerId === p.id && s.periodStart <= to && s.periodEnd >= from);
    if (sts.length) {
      const total = sts.reduce((t, s) => t + computeSettlement(data, ledger, s, asOf).calc.total, 0);
      hospitals.push({ payerId: p.id, name: p.name, amount: total, estimate: sts.some((s) => !s.finalized), fromSettlement: true });
      continue;
    }
    const ag = agreementFor(data.agreements, p.id, from);
    if (!ag) continue;
    const rev = eligibleRevenue(data, ledger, p.id, from, to);
    const needsFigure = ag.base === "collected" || ag.base === "custom";
    const c = calcAgreement(ag, settlementBase(ag, rev, {}), null);
    hospitals.push({ payerId: p.id, name: p.name, amount: c.amount, estimate: true, needsFigure: needsFigure && c.share === 0 && c.amount === 0, fromSettlement: false });
  }
  return { direct, hospitals, total: direct + hospitals.reduce((t, x) => t + x.amount, 0) };
}

export function dashboard(store, todayIso) {
  const L = store.ledger;
  const ym = todayIso.slice(0, 7);
  const month = monthRange(ym);
  const day = { from: todayIso, to: todayIso };
  const actToday = activityTotals(L, day);
  const actMonth = activityTotals(L, month);
  const colToday = collectionTotals(L, day);
  const colMonth = collectionTotals(L, month);
  const receivable = patientReceivable(L, todayIso);
  let hospitalDue = 0;
  let overdue = 0;
  for (const s of store.data.settlements) {
    if (s.voided) continue;
    const v = computeSettlement(store.data, L, s, todayIso);
    if (v.balance > 0) hospitalDue += v.balance;
    if (v.status.includes("overdue")) overdue++;
  }
  const needsRecon = [...L.sessionFin.entries()].filter(([, f]) => f.needsRecon).map(([id]) => L.sessionById.get(id));
  const byLoc = new Map();
  for (const s of L.sessionById.values()) {
    if (s.date < month.from || s.date > month.to) continue;
    const f = L.sessionFin.get(s.id).eff;
    const r = byLoc.get(s.locationId) || { locationId: s.locationId, name: L.locById.get(s.locationId)?.name || "", patients: 0, net: 0 };
    r.patients += f.visits;
    r.net += f.net;
    byLoc.set(s.locationId, r);
  }
  const locs = [...byLoc.values()];
  return {
    actToday,
    actMonth,
    colToday,
    colMonth,
    receivable,
    hospitalDue,
    overdue,
    needsRecon,
    earnings: expectedEarnings(store.data, L, ym, todayIso),
    actualReceived: colMonth.patient + colMonth.hospital,
    topByPatients: [...locs].sort((a, b) => b.patients - a.patients).slice(0, 5),
    topByIncome: [...locs].sort((a, b) => b.net - a.net).slice(0, 5),
  };
}
