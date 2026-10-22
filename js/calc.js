// Pure financial calculations. No storage, no DOM: everything here is a function of
// the plain data arrays, so the same rules drive the screens, reports and tests.
//
// Definitions (see docs/DESIGN.md §4):
//   gross       = sum of consultation fees of genuine (non-cancelled, non-voided) visits
//   net         = gross − discounts − waivers ± corrections
//   collection  = sum of actual patient payments (minus refunds) by PAYMENT date
//   outstanding = net − payments allocated to those visits/sessions
//   patients    = number of genuine visit records in visit categories (not payments)
//
// A session is counted from exactly ONE source: its summary or its individual
// visits, never both (see sessionSource).

import { applyBp, sum } from "./money.js";
import { inRange, addDays } from "./dates.js";

export function mapBy(arr, key = "id") {
  const m = new Map();
  for (const x of arr) m.set(x[key], x);
  return m;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    let g = m.get(k);
    if (!g) m.set(k, (g = []));
    g.push(x);
  }
  return m;
}

const tkey = (type, id) => type + ":" + id;

// Rate record in force at `date` for a location (latest effectiveFrom <= date).
export function rateFor(rates, locationId, date) {
  let best = null;
  for (const r of rates) {
    if (r.locationId !== locationId || r.voided || r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom === best.effectiveFrom && r.createdAt > best.createdAt)) best = r;
  }
  return best;
}

export function categoryFee(rate, key) {
  const c = rate && rate.categories.find((c) => c.key === key);
  return c ? c.feePaise : null;
}

// Agreement in force at `date` for a hospital/payer.
export function agreementFor(agreements, payerId, date) {
  let best = null;
  for (const a of agreements) {
    if (a.payerId !== payerId || a.voided || a.effectiveFrom > date) continue;
    if (!best || a.effectiveFrom > best.effectiveFrom || (a.effectiveFrom === best.effectiveFrom && a.createdAt > best.createdAt)) best = a;
  }
  return best;
}

export function signed(payment, amount) {
  return payment.kind === "refund" ? -amount : amount;
}

function emptyTotals() {
  return { newCount: 0, followupCount: 0, otherCount: 0, visits: 0, gross: 0, discount: 0, correction: 0, net: 0, paid: 0, outstanding: 0 };
}

export function summaryTotals(session, sessionAdjs = []) {
  const t = emptyTotals();
  const sm = session.summary;
  if (!sm) return null;
  let lineGross = 0;
  for (const l of sm.lines || []) {
    const c = l.count || 0;
    if (l.isVisit !== false) {
      if (l.key === "new") t.newCount += c;
      else if (l.key === "followup") t.followupCount += c;
      else t.otherCount += c;
      t.visits += c;
    }
    lineGross += c * (l.feePaise || 0);
  }
  t.gross = sm.grossOverridePaise !== null && sm.grossOverridePaise !== undefined ? sm.grossOverridePaise : lineGross;
  t.lineGross = lineGross;
  t.discount = (sm.discountPaise || 0) + sum(sessionAdjs.filter((a) => a.type === "discount" || a.type === "waiver"), (a) => a.amountPaise);
  t.correction = sum(sessionAdjs.filter((a) => a.type === "correction"), (a) => a.amountPaise);
  t.net = t.gross - t.discount + t.correction;
  return t;
}

// Which records count for a session: "summary" or "individual".
export function sessionSource(session, visitCount) {
  if (session.mode === "individual") return "individual";
  if (session.mode === "summary" && visitCount === 0) return "summary";
  // summary_recon (or summary that has gained visits)
  if (session.status === "reconciled" && session.recon) return session.recon.source || "individual";
  if (!session.summary) return "individual";
  return "summary"; // provisional until reviewed
}

export function needsReconciliation(session, visitCount) {
  const recon = session.mode === "summary_recon" || (session.mode === "summary" && visitCount > 0);
  return recon && session.status !== "reconciled";
}

// Build the full ledger. Returns per-visit and per-session figures plus the flat list
// of counted money movements ("entries") that every collection report sums.
export function computeLedger(data) {
  const sessions = data.sessions.filter((s) => !s.voided);
  const sessionById = mapBy(sessions);
  const locById = mapBy(data.locations);
  const visits = data.visits.filter((v) => !v.voided && sessionById.has(v.sessionId));
  const visitsBySession = groupBy(visits, (v) => v.sessionId);
  const payById = mapBy(data.payments.filter((p) => !p.voided));
  const allocs = data.allocations.filter((a) => payById.has(a.paymentId));
  const allocByTarget = groupBy(allocs, (a) => tkey(a.targetType, a.targetId));
  const allocByPayment = groupBy(allocs, (a) => a.paymentId);
  const adjs = data.adjustments.filter((a) => !a.voided);
  const adjByTarget = groupBy(adjs, (a) => tkey(a.targetType, a.targetId));

  const visitFin = new Map();
  const sessionFin = new Map();
  const entries = [];

  for (const v of visits) {
    const va = adjByTarget.get(tkey("visit", v.id)) || [];
    const discount = sum(va.filter((a) => a.type === "discount" || a.type === "waiver"), (a) => a.amountPaise);
    const waiver = sum(va.filter((a) => a.type === "waiver"), (a) => a.amountPaise);
    const correction = sum(va.filter((a) => a.type === "correction"), (a) => a.amountPaise);
    const gross = v.cancelled ? 0 : v.feePaise;
    const net = v.cancelled ? 0 : gross - discount + correction;
    const vAllocs = allocByTarget.get(tkey("visit", v.id)) || [];
    const paid = sum(vAllocs, (a) => signed(payById.get(a.paymentId), a.amountPaise));
    const outstanding = net - paid;
    let status;
    if (v.cancelled) status = paid > 0 ? "refund_due" : "cancelled";
    else if (net === 0 && (waiver > 0 || discount > 0)) status = "waived";
    else if (outstanding <= 0 && net > 0) status = "paid";
    else if (net === 0) status = paid > 0 ? "paid" : "free";
    else if (paid > 0) status = "partial";
    else status = "unpaid";
    visitFin.set(v.id, { gross, discount, waiver, correction, net, paid, outstanding, status, counts: !v.cancelled && v.isVisit !== false });
  }

  for (const s of sessions) {
    const vs = visitsBySession.get(s.id) || [];
    const sAdjs = adjByTarget.get(tkey("session", s.id)) || [];
    const sumT = summaryTotals(s, sAdjs);
    const indT = emptyTotals();
    for (const v of vs) {
      const f = visitFin.get(v.id);
      if (f.counts) {
        if (v.category === "new") indT.newCount++;
        else if (v.category === "followup") indT.followupCount++;
        else indT.otherCount++;
        indT.visits++;
      }
      indT.gross += f.gross;
      indT.discount += f.discount;
      indT.correction += f.correction;
      indT.net += f.net;
    }
    const source = sessionSource(s, vs.length);
    const eff = { ...(source === "summary" ? sumT : indT) };

    // Payments touching this session (session-level and visit-level allocations).
    const touching = [...(allocByTarget.get(tkey("session", s.id)) || [])];
    for (const v of vs) touching.push(...(allocByTarget.get(tkey("visit", v.id)) || []));
    let paid = 0;
    let summaryCollected = 0;
    let visitSameDay = 0;
    for (const a of touching) {
      const p = payById.get(a.paymentId);
      const amt = signed(p, a.amountPaise);
      if (p.origin === "summary") summaryCollected += amt;
      else if (a.targetType === "visit" && p.date === s.date) visitSameDay += amt;
      let counted;
      if (p.origin === "summary") counted = source === "summary";
      else if (a.targetType === "visit") counted = source === "individual" || p.date > s.date;
      else counted = true;
      if (!counted) continue;
      paid += amt;
      entries.push({
        paymentId: p.id,
        date: p.date,
        amount: amt,
        kind: p.kind,
        method: p.method,
        reference: p.reference || "",
        payerType: "patient",
        locationId: s.locationId,
        sessionId: s.id,
        visitId: a.targetType === "visit" ? a.targetId : null,
        origin: p.origin,
      });
    }
    eff.paid = paid;
    eff.outstanding = s.collector === "hospital" ? 0 : eff.net - paid;
    if (sumT) {
      sumT.paid = summaryCollected;
      sumT.outstanding = s.collector === "hospital" ? 0 : sumT.net - summaryCollected;
    }
    indT.paid = visitSameDay;
    indT.outstanding = s.collector === "hospital" ? 0 : indT.net - visitSameDay;

    let recon = null;
    const hasRecon = s.mode === "summary_recon" || (s.mode === "summary" && vs.length > 0);
    if (hasRecon && sumT) {
      const items = ["newCount", "followupCount", "visits", "gross", "discount", "net", "paid", "outstanding"].map((k) => ({
        key: k,
        summary: sumT[k],
        individual: indT[k],
        diff: indT[k] - sumT[k],
      }));
      recon = { items, matches: items.every((i) => i.diff === 0) };
    }
    sessionFin.set(s.id, {
      source,
      summary: sumT,
      individual: indT,
      eff,
      visitCount: vs.length,
      needsRecon: needsReconciliation(s, vs.length),
      recon,
      location: locById.get(s.locationId) || null,
    });
  }

  // Unallocated parts of payments (explicit advances) and hospital settlement payments.
  for (const p of payById.values()) {
    const as = allocByPayment.get(p.id) || [];
    if (p.payerType === "hospital") {
      for (const a of as) {
        entries.push({
          paymentId: p.id, date: p.date, amount: signed(p, a.amountPaise), kind: p.kind, method: p.method, reference: p.reference || "",
          payerType: "hospital", payerId: p.payerId, settlementId: a.targetId, locationId: null, sessionId: null, visitId: null, origin: p.origin,
        });
      }
    }
    const allocated = sum(as, (a) => a.amountPaise);
    const rest = p.amountPaise - allocated;
    if (rest > 0) {
      entries.push({
        paymentId: p.id, date: p.date, amount: signed(p, rest), kind: p.kind, method: p.method, reference: p.reference || "",
        payerType: p.payerType, payerId: p.payerId || null, settlementId: null, locationId: p.locationId || null,
        sessionId: null, visitId: null, origin: p.origin, advance: true,
      });
    }
  }

  return { visitFin, sessionFin, entries, sessionById, locById, payById, allocByTarget, allocByPayment, adjByTarget, visitsBySession };
}

// ---------------------------------------------------------------- settlements

// Sessions whose fees the hospital collected, at the hospital's locations, in [from, to].
export function eligibleRevenue(data, ledger, payerId, from, to) {
  const out = { gross: 0, net: 0, visits: 0, sessions: 0 };
  for (const s of ledger.sessionById.values()) {
    if (s.collector !== "hospital" || !inRange(s.date, from, to)) continue;
    const loc = ledger.locById.get(s.locationId);
    if (!loc || loc.payerId !== payerId) continue;
    const f = ledger.sessionFin.get(s.id).eff;
    out.gross += f.gross;
    out.net += f.net;
    out.visits += f.visits;
    out.sessions++;
  }
  return out;
}

// Amount due under an agreement for one settlement period. Salary and minimum
// guarantee are amounts per settlement period.
export function calcAgreement(agreement, baseAmount, manualAmountPaise) {
  const t = agreement ? agreement.type : "manual";
  const pct = agreement && agreement.pctBp ? agreement.pctBp : 0;
  const salary = agreement && agreement.salaryPaise ? agreement.salaryPaise : 0;
  const minimum = agreement && agreement.minPaise ? agreement.minPaise : 0;
  const usesPct = ["pct", "max_min_pct", "min_plus_pct", "salary_plus_pct"].includes(t);
  const share = usesPct ? applyBp(baseAmount || 0, pct) : 0;
  let amount = 0;
  let formula = "";
  switch (t) {
    case "fixed":
      amount = salary;
      formula = "Fixed salary";
      break;
    case "pct":
      amount = share;
      formula = "Eligible revenue × %";
      break;
    case "min":
      amount = minimum;
      formula = "Minimum guaranteed amount";
      break;
    case "max_min_pct":
      amount = Math.max(minimum, share);
      formula = "MAX(minimum, eligible revenue × %)";
      break;
    case "min_plus_pct":
      amount = minimum + share;
      formula = "Minimum + eligible revenue × %";
      break;
    case "salary_plus_pct":
      amount = salary + share;
      formula = "Salary + eligible revenue × %";
      break;
    default:
      amount = manualAmountPaise || 0;
      formula = "Manually entered amount";
  }
  return {
    type: t,
    base: usesPct ? baseAmount || 0 : 0,
    pctBp: usesPct ? pct : 0,
    share,
    salary: ["fixed", "salary_plus_pct"].includes(t) ? salary : 0,
    minimum: ["min", "max_min_pct", "min_plus_pct"].includes(t) ? minimum : 0,
    amount,
    formula,
  };
}

export function settlementBase(agreement, rev, settlement) {
  const base = agreement ? agreement.base : "gross";
  if (base === "net") return rev.net;
  if (base === "collected" || base === "custom") return settlement.reportedBasePaise || 0;
  return rev.gross;
}

export function computeSettlement(data, ledger, settlement, asOf) {
  const agreement = agreementFor(data.agreements, settlement.payerId, settlement.periodStart);
  const rev = eligibleRevenue(data, ledger, settlement.payerId, settlement.periodStart, settlement.periodEnd);
  const base = settlementBase(agreement, rev, settlement);
  const live = calcAgreement(agreement, base, settlement.manualAmountPaise);
  const adjs = ledger.adjByTarget.get(tkey("settlement", settlement.id)) || [];
  const adjustments = sum(adjs, (a) => a.amountPaise);
  live.adjustments = adjustments;
  live.total = live.amount + adjustments;
  live.eligible = rev;
  const calc = settlement.finalized ? { ...settlement.finalized.calc, adjustments, total: settlement.finalized.calc.amount + adjustments } : live;
  const paid = sum(
    ledger.entries.filter((e) => e.payerType === "hospital" && e.settlementId === settlement.id),
    (e) => e.amount,
  );
  const balance = calc.total - paid;
  const dueDate = settlement.dueDate || addDays(settlement.periodEnd, agreement ? agreement.dueAfterDays || 0 : 0);
  let status;
  if (calc.total > 0 && balance <= 0) status = "paid";
  else if (paid > 0) status = "partial";
  else status = "unpaid";
  if (status !== "paid" && asOf && asOf > dueDate) status = status === "partial" ? "partial_overdue" : "overdue";
  return {
    settlement,
    agreement,
    calc,
    live,
    drift: settlement.finalized ? live.total - calc.total : 0,
    paid,
    balance,
    dueDate,
    status,
  };
}

// --------------------------------------------------------------- aggregation

// Activity (counts, fees) by session date.
export function activityTotals(ledger, filter = {}) {
  const t = { sessions: 0, visits: 0, newCount: 0, followupCount: 0, otherCount: 0, gross: 0, discount: 0, net: 0, directNet: 0, hospitalNet: 0 };
  for (const s of ledger.sessionById.values()) {
    if (!matchSession(s, ledger, filter)) continue;
    const f = ledger.sessionFin.get(s.id).eff;
    t.sessions++;
    t.visits += f.visits;
    t.newCount += f.newCount;
    t.followupCount += f.followupCount;
    t.otherCount += f.otherCount;
    t.gross += f.gross;
    t.discount += f.discount - f.correction;
    t.net += f.net;
    if (s.collector === "hospital") t.hospitalNet += f.net;
    else t.directNet += f.net;
  }
  return t;
}

export function matchSession(s, ledger, filter) {
  if (!inRange(s.date, filter.from, filter.to)) return false;
  if (filter.locationIds && filter.locationIds.length && !filter.locationIds.includes(s.locationId)) return false;
  if (filter.payerId) {
    const loc = ledger.locById.get(s.locationId);
    if (!loc || loc.payerId !== filter.payerId) return false;
  }
  if (filter.sessionName && s.sessionName !== filter.sessionName) return false;
  return true;
}

// Money received by payment date.
export function collectionTotals(ledger, filter = {}) {
  const t = { patient: 0, hospital: 0, refunds: 0, byMethod: { cash: 0, upi: 0, bank: 0, other: 0 } };
  for (const e of ledger.entries) {
    if (!inRange(e.date, filter.from, filter.to)) continue;
    if (filter.locationIds && filter.locationIds.length && !filter.locationIds.includes(e.locationId)) continue;
    if (filter.payerId && e.payerType === "hospital" && e.payerId !== filter.payerId) continue;
    if (filter.payerId && e.payerType === "patient") {
      const loc = ledger.locById.get(e.locationId);
      if (!loc || loc.payerId !== filter.payerId) continue;
    }
    if (e.payerType === "hospital") t.hospital += e.amount;
    else {
      t.patient += e.amount;
      t.byMethod[e.method] = (t.byMethod[e.method] || 0) + e.amount;
      if (e.amount < 0) t.refunds += -e.amount;
    }
  }
  return t;
}

// Patient receivable at end of `asOf`: net fees of direct sessions on/before asOf minus
// counted patient payments dated on/before asOf.
export function patientReceivable(ledger, asOf, filter = {}) {
  let due = 0;
  for (const s of ledger.sessionById.values()) {
    if (s.collector === "hospital" || s.date > asOf) continue;
    if (!matchSession(s, ledger, { ...filter, from: null, to: null })) continue;
    due += ledger.sessionFin.get(s.id).eff.net;
  }
  for (const e of ledger.entries) {
    if (e.payerType !== "patient" || e.date > asOf || !e.sessionId) continue;
    const s = ledger.sessionById.get(e.sessionId);
    if (!matchSession(s, ledger, { ...filter, from: null, to: null })) continue;
    due -= e.amount;
  }
  return due;
}
