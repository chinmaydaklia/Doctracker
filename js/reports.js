// Report builders. Each returns { columns, rows, totals } where money is in paise.
// Consultation activity is grouped by SESSION date; money received by PAYMENT date.
// A payment received in a later month is a collection of that later month and never
// new consultation revenue.

import { matchSession, computeSettlement, patientReceivable, mapBy } from "./calc.js";
import { inRange, monthKey, monthsBetween, monthRange, fmtMonth, fmtDate } from "./dates.js";
import { METHODS, SESSION_MODES } from "./model.js";
import { sum } from "./money.js";

export const MONEY = "money";

function sessionLabel(s) {
  const n = s.sessionName;
  return n ? n[0].toUpperCase() + n.slice(1) : "";
}

function entryMatches(e, ledger, filter) {
  if (!inRange(e.date, filter.from, filter.to)) return false;
  if (filter.locationIds && filter.locationIds.length && !filter.locationIds.includes(e.locationId)) return false;
  if (filter.payerId) {
    if (e.payerType === "hospital") return e.payerId === filter.payerId;
    const loc = ledger.locById.get(e.locationId);
    if (!loc || loc.payerId !== filter.payerId) return false;
  }
  if (filter.sessionName && e.sessionId) {
    const s = ledger.sessionById.get(e.sessionId);
    if (s && s.sessionName !== filter.sessionName) return false;
  }
  return true;
}

function sortedSessions(ledger, filter) {
  return [...ledger.sessionById.values()].filter((s) => matchSession(s, ledger, filter)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
}

// Daily: one row per session, plus one row per day/location for payments received
// that day for earlier sessions (or as advances). Sum of "Collected" = all patient
// collections in the range; "Outstanding" is the session's balance as of today.
export function dailyReport(ledger, filter) {
  const columns = [
    { key: "date", label: "Date", type: "date" },
    { key: "location", label: "Location" },
    { key: "session", label: "Session" },
    { key: "patients", label: "Patients", type: "int" },
    { key: "gross", label: "Gross fees", type: MONEY },
    { key: "discount", label: "Discounts", type: MONEY },
    { key: "net", label: "Net fees", type: MONEY },
    { key: "collected", label: "Collected", type: MONEY },
    { key: "outstanding", label: "Outstanding", type: MONEY },
  ];
  const rows = [];
  const sameDay = new Map(); // sessionId -> amount collected on session date
  const later = new Map(); // date|location -> amount
  for (const e of ledger.entries) {
    if (e.payerType !== "patient" || !entryMatches(e, ledger, filter)) continue;
    const s = e.sessionId ? ledger.sessionById.get(e.sessionId) : null;
    if (s && s.date === e.date) sameDay.set(s.id, (sameDay.get(s.id) || 0) + e.amount);
    else {
      const k = e.date + "|" + (e.locationId || "");
      later.set(k, (later.get(k) || 0) + e.amount);
    }
  }
  for (const s of sortedSessions(ledger, filter)) {
    const f = ledger.sessionFin.get(s.id);
    rows.push({
      date: s.date,
      location: ledger.locById.get(s.locationId)?.name || "",
      session: sessionLabel(s) + (s.collector === "hospital" ? " (hospital collects)" : "") + (f.needsRecon ? " ⚠" : ""),
      patients: f.eff.visits,
      gross: f.eff.gross,
      discount: f.eff.discount - f.eff.correction,
      net: f.eff.net,
      collected: sameDay.get(s.id) || 0,
      outstanding: f.eff.outstanding,
      sessionId: s.id,
    });
  }
  for (const [k, amt] of later) {
    const [date, locId] = k.split("|");
    rows.push({ date, location: ledger.locById.get(locId)?.name || "—", session: "Payments for earlier visits / advances", patients: 0, gross: 0, discount: 0, net: 0, collected: amt, outstanding: null });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { columns, rows, totals: totalsOf(columns, rows) };
}

export function monthlyReport(ledger, filter, asOfToday) {
  const columns = [
    { key: "month", label: "Month" },
    { key: "patients", label: "Patients", type: "int" },
    { key: "newCount", label: "New", type: "int" },
    { key: "followupCount", label: "Follow-ups", type: "int" },
    { key: "gross", label: "Gross fees", type: MONEY },
    { key: "net", label: "Consultation revenue (net)", type: MONEY },
    { key: "collected", label: "Patient collections", type: MONEY },
    { key: "hospitalPaid", label: "Hospital payments", type: MONEY },
    { key: "outstanding", label: "Patient outstanding (month end)", type: MONEY, noTotal: true },
  ];
  const from = filter.from || firstDate(ledger) || asOfToday;
  const to = filter.to || asOfToday;
  const rows = monthsBetween(from, to).map((ym) => {
    const r = monthRange(ym);
    return { month: fmtMonth(ym), ym, patients: 0, newCount: 0, followupCount: 0, gross: 0, net: 0, collected: 0, hospitalPaid: 0, outstanding: patientReceivable(ledger, r.to < asOfToday ? r.to : asOfToday, filter) };
  });
  const byYm = mapBy(rows, "ym");
  for (const s of sortedSessions(ledger, { ...filter, from, to })) {
    const row = byYm.get(monthKey(s.date));
    const f = ledger.sessionFin.get(s.id).eff;
    row.patients += f.visits;
    row.newCount += f.newCount;
    row.followupCount += f.followupCount;
    row.gross += f.gross;
    row.net += f.net;
  }
  for (const e of ledger.entries) {
    if (!entryMatches(e, ledger, { ...filter, from, to })) continue;
    const row = byYm.get(monthKey(e.date));
    if (!row) continue;
    if (e.payerType === "hospital") row.hospitalPaid += e.amount;
    else row.collected += e.amount;
  }
  return { columns, rows, totals: totalsOf(columns, rows) };
}

function firstDate(ledger) {
  let d = null;
  for (const s of ledger.sessionById.values()) if (!d || s.date < d) d = s.date;
  return d;
}

export function locationReport(ledger, filter) {
  const columns = [
    { key: "location", label: "Location" },
    { key: "patients", label: "Patients", type: "int" },
    { key: "avgFee", label: "Average fee", type: MONEY, noTotal: true },
    { key: "gross", label: "Gross fees", type: MONEY },
    { key: "net", label: "Net fees", type: MONEY },
    { key: "collected", label: "Patient collections", type: MONEY },
  ];
  const byLoc = new Map();
  const row = (id) => {
    if (!byLoc.has(id)) byLoc.set(id, { location: ledger.locById.get(id)?.name || "—", locationId: id, patients: 0, gross: 0, net: 0, collected: 0 });
    return byLoc.get(id);
  };
  for (const s of sortedSessions(ledger, filter)) {
    const f = ledger.sessionFin.get(s.id).eff;
    const r = row(s.locationId);
    r.patients += f.visits;
    r.gross += f.gross;
    r.net += f.net;
  }
  for (const e of ledger.entries) {
    if (e.payerType !== "patient" || !e.locationId || !entryMatches(e, ledger, filter)) continue;
    row(e.locationId).collected += e.amount;
  }
  const rows = [...byLoc.values()].map((r) => ({ ...r, avgFee: r.patients ? Math.round(r.gross / r.patients) : 0 })).sort((a, b) => b.patients - a.patients);
  const totals = totalsOf(columns, rows);
  totals.avgFee = totals.patients ? Math.round(totals.gross / totals.patients) : 0;
  return { columns, rows, totals };
}

// One row per payment (per session it was allocated to).
export function paymentReport(ledger, filter, payerName) {
  const columns = [
    { key: "date", label: "Date", type: "date" },
    { key: "payer", label: "Payer" },
    { key: "location", label: "Location" },
    { key: "method", label: "Payment method" },
    { key: "amount", label: "Amount", type: MONEY },
    { key: "reference", label: "Reference" },
  ];
  const grouped = new Map();
  for (const e of ledger.entries) {
    if (!entryMatches(e, ledger, filter)) continue;
    const k = e.paymentId + "|" + (e.sessionId || e.settlementId || "adv");
    const g = grouped.get(k);
    if (g) {
      g.amount += e.amount;
      continue;
    }
    let payer = e.payerType === "hospital" ? payerName(e.payerId) : "Patient";
    if (e.kind === "refund") payer = "Refund to patient";
    if (e.advance) payer += " (advance)";
    if (e.origin === "summary") payer += " (session summary)";
    let location = e.locationId ? ledger.locById.get(e.locationId)?.name || "" : "";
    grouped.set(k, { date: e.date, payer, location, method: METHODS[e.method] || e.method, amount: e.amount, reference: e.reference, payerType: e.payerType });
  }
  const rows = [...grouped.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { columns, rows, totals: totalsOf(columns, rows) };
}

export function settlementReport(data, ledger, filter, asOfToday, payerName) {
  const columns = [
    { key: "hospital", label: "Hospital" },
    { key: "period", label: "Period" },
    { key: "salary", label: "Salary / minimum", type: MONEY },
    { key: "eligible", label: "Eligible revenue", type: MONEY },
    { key: "share", label: "Revenue share", type: MONEY },
    { key: "adjustments", label: "Adjustments", type: MONEY },
    { key: "total", label: "Total payable", type: MONEY },
    { key: "paid", label: "Paid", type: MONEY },
    { key: "balance", label: "Balance due", type: MONEY },
    { key: "status", label: "Status" },
  ];
  const rows = data.settlements
    .filter((s) => !s.voided && (!filter.payerId || s.payerId === filter.payerId) && (!filter.from || s.periodEnd >= filter.from) && (!filter.to || s.periodStart <= filter.to))
    .map((s) => {
      const v = computeSettlement(data, ledger, s, asOfToday);
      return {
        hospital: payerName(s.payerId),
        period: fmtDate(s.periodStart) + " to " + fmtDate(s.periodEnd),
        periodStart: s.periodStart,
        salary: v.calc.salary + v.calc.minimum,
        eligible: v.calc.base,
        share: v.calc.share,
        adjustments: v.calc.adjustments,
        total: v.calc.total,
        paid: v.paid,
        balance: v.balance,
        status: STATUS_LABEL[v.status] + (s.finalized ? "" : " (provisional)"),
        settlementId: s.id,
      };
    })
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
  return { columns, rows, totals: totalsOf(columns, rows) };
}

export const STATUS_LABEL = { paid: "Paid", partial: "Part paid", unpaid: "Unpaid", overdue: "Overdue", partial_overdue: "Part paid, overdue" };

export function reconciliationReport(ledger, filter) {
  const columns = [
    { key: "date", label: "Date", type: "date" },
    { key: "session", label: "Session" },
    { key: "summaryCount", label: "Summary count", type: "int" },
    { key: "individualCount", label: "Individual count", type: "int" },
    { key: "feeDiff", label: "Fee difference", type: MONEY },
    { key: "collectionDiff", label: "Collection difference", type: MONEY },
    { key: "status", label: "Status" },
  ];
  const rows = [];
  for (const s of sortedSessions(ledger, filter)) {
    const f = ledger.sessionFin.get(s.id);
    if (!f.recon) continue;
    const item = (k) => f.recon.items.find((i) => i.key === k);
    rows.push({
      date: s.date,
      session: (ledger.locById.get(s.locationId)?.name || "") + " · " + sessionLabel(s),
      summaryCount: item("visits").summary,
      individualCount: item("visits").individual,
      feeDiff: item("gross").diff,
      collectionDiff: item("paid").diff,
      status: s.status === "reconciled" ? `Reconciled (${s.recon.source === "summary" ? "summary kept" : "individual records"})` : f.recon.matches ? "Matches — confirm" : "Needs reconciliation",
      sessionId: s.id,
    });
  }
  return { columns, rows, totals: null };
}

function totalsOf(columns, rows) {
  const t = {};
  for (const c of columns) {
    if ((c.type === MONEY || c.type === "int") && !c.noTotal) t[c.key] = sum(rows, (r) => r[c.key] || 0);
  }
  return t;
}

export { SESSION_MODES };
