// Import from the earlier single-page tracker (legacy.html, localStorage keys
// hosp / ent3 / pays / adms, or its JSON backup). Each old day/round/ward becomes a
// summary-only session; old monthly hospital payments become finalised settlements
// with a manually entered amount. Admissions (patient names) and expenses are not
// imported: they are outside this app's scope and stay available in legacy.html.

import { newId, newSessionId } from "./ids.js";
import { monthRange } from "./dates.js";
import { defaultCategories } from "./model.js";

const SUBS = [
  ["icu", "ICU"],
  ["pvt", "Private ward"],
  ["ward", "General ward"],
  ["opd", "OPD"],
];

export function readLegacyLocalStorage(ls = globalThis.localStorage) {
  if (!ls) return null;
  const g = (k) => {
    try {
      const v = ls.getItem(k);
      return v === null ? null : JSON.parse(v);
    } catch {
      return null;
    }
  };
  const entries = g("ent3");
  if (!entries || !entries.length) return null;
  return { hospitals: g("hosp") || [], entries, payments: g("pays") || [], admissions: g("adms") || [] };
}

const P = (rupees) => Math.round(Number(rupees || 0) * 100);
const cnt = (x) => Math.max(0, Math.round(Number(x || 0)));

export function convertLegacy(legacy, { now = Date.now(), today }) {
  const out = { payers: [], locations: [], rates: [], sessions: [], payments: [], allocations: [], settlements: [], skippedAdmissions: (legacy.admissions || []).length, expensesPaise: 0 };
  const payerByName = new Map();
  const locByKey = new Map();
  const entries = (legacy.entries || []).filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const firstDate = entries.length ? entries[0].date : today;

  const payer = (name) => {
    name = String(name || "Unknown hospital").trim();
    if (!payerByName.has(name)) {
      const p = { id: newId("H"), name, active: true, createdAt: now };
      payerByName.set(name, p);
      out.payers.push(p);
    }
    return payerByName.get(name);
  };
  const location = (hosp, subKey, subLabel, fee) => {
    const key = hosp + "|" + subKey;
    if (!locByKey.has(key)) {
      const p = payer(hosp);
      const l = { id: newId("LOC"), name: `${p.name} — ${subLabel}`, nameHi: "", kind: "hospital", payerId: p.id, arrangement: "hospital", active: true, sortOrder: 100 + out.locations.length, createdAt: now, updatedAt: now };
      locByKey.set(key, l);
      out.locations.push(l);
      out.rates.push({ id: newId("R"), locationId: l.id, effectiveFrom: firstDate, categories: defaultCategories(fee, fee), note: "Imported from old tracker", createdAt: now });
    }
    return locByKey.get(key);
  };
  for (const h of legacy.hospitals || []) payer(h);

  for (const e of entries) {
    const rounds = e.rt === "morning" ? ["morning"] : e.rt === "evening" ? ["evening"] : ["morning", "evening"];
    for (const rn of rounds) {
      const r = e[rn];
      if (!r) continue;
      for (const [k, label] of SUBS) {
        const c = r[k] ? cnt(r[k].c) : 0;
        if (!c) continue;
        const included = k !== "opd" || r.opd.inc !== false;
        const fee = included ? P(r[k].r) : 0;
        const loc = location(e.hosp, k, label, P(r[k].r));
        out.sessions.push(summarySession(e, rn, loc, [{ key: "visit", label: included ? "Visit (old tracker)" : "Visit (fee not counted in old tracker)", count: c, feePaise: fee, isVisit: true }], now));
      }
    }
    const procs = (e.procs || []).filter((p) => cnt(p.c) > 0);
    if (procs.length) {
      const loc = location(e.hosp, "proc", "Procedures", 0);
      out.sessions.push(summarySession(e, "procedures", loc, procs.map((p, i) => ({ key: "proc" + i, label: "Procedure: " + (p.name || "other"), count: cnt(p.c), feePaise: P(p.r), isVisit: false })), now));
    }
    for (const x of e.exps || []) out.expensesPaise += P(x.amt);
  }

  for (const p of legacy.payments || []) {
    if (!/^\d{4}-\d{2}$/.test(p.month || "")) continue;
    const payerRec = payer(p.hosp);
    const range = monthRange(p.month);
    const amount = P(p.exp);
    const st = {
      id: newId("ST"), payerId: payerRec.id, periodStart: range.from, periodEnd: range.to, dueDate: null, reportedBasePaise: null, manualAmountPaise: amount,
      notes: ("Imported from old tracker. " + (p.notes || "")).trim(), voided: false, createdAt: now,
      finalized: { at: now, by: "import", calc: { type: "manual", base: 0, pctBp: 0, share: 0, salary: 0, minimum: 0, amount, formula: "Manually entered amount" } },
    };
    out.settlements.push(st);
    const rec = P(p.rec);
    if (rec > 0) {
      const date = range.to < today ? range.to : today;
      const pay = { id: newId("P"), date, kind: "payment", payerType: "hospital", payerId: payerRec.id, locationId: null, method: "bank", amountPaise: rec, reference: "old tracker", origin: "import", sessionId: null, advance: rec > amount, notes: "Payment date not recorded in old tracker", voided: false, createdAt: now };
      out.payments.push(pay);
      if (amount > 0) out.allocations.push({ id: newId("AL"), paymentId: pay.id, targetType: "settlement", targetId: st.id, amountPaise: Math.min(rec, amount) });
    }
  }
  return out;
}

function summarySession(e, sessionName, loc, lines, now) {
  return {
    id: newSessionId(e.date, loc.name, sessionName),
    date: e.date,
    locationId: loc.id,
    sessionName,
    mode: "summary",
    collector: "hospital",
    summary: { lines, grossOverridePaise: null, discountPaise: 0 },
    status: "open",
    recon: null,
    remarks: "Imported from old tracker",
    voided: false,
    createdAt: now,
    updatedAt: now,
  };
}
