// Money: patient receivables, payments list, hospitals & settlements.
import { h, add, clear, money, date, field, moneyInput, dateInput, segmented, select, toast, modal, askReason, attempt, badge, confirmDialog } from "./dom.js";
import { today, addDays, periodFor, addMonths, fmtDateTime } from "../dates.js";
import { METHODS, AGREEMENT_TYPES, REVENUE_BASES, FREQUENCIES } from "../model.js";
import { agreementFor } from "../calc.js";
import { bpToPct, pctToBp } from "../money.js";
import { STATUS_LABEL } from "../reports.js";
import { payDialog, adjustDialog } from "./sessions.js";
import { cap } from "./entry.js";

export function renderMoney(app, params) {
  const tab = params.tab || "due";
  const body = tab === "due" ? duePanel(app) : tab === "payments" ? paymentsPanel(app) : hospitalsPanel(app);
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Money"),
    segmented([{ value: "due", label: "Patient balances" }, { value: "payments", label: "Payments" }, { value: "hospitals", label: "Hospitals" }], tab, (v) => app.go("money", { tab: v }, { replace: true })),
    body,
  );
}

// Outstanding patient balances: visits (individual source) and summary sessions.
function outstandingItems(store) {
  const L_ = store.ledger;
  const items = [];
  for (const s of L_.sessionById.values()) {
    if (s.collector !== "me") continue;
    const f = L_.sessionFin.get(s.id);
    if (f.source === "individual") {
      for (const v of L_.visitsBySession.get(s.id) || []) {
        const vf = L_.visitFin.get(v.id);
        if (vf.outstanding > 0) items.push({ type: "visit", id: v.id, date: s.date, s, label: [v.patientId, v.patientName].filter(Boolean).join(" · ") || v.categoryLabel, outstanding: vf.outstanding });
      }
      // Session-level later payments can also have reduced the balance; visits are the detail.
    } else if (f.eff.outstanding > 0) {
      items.push({ type: "session", id: s.id, date: s.date, s, label: `Session summary · ${f.eff.visits} patients`, outstanding: f.eff.outstanding });
    }
  }
  return items.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function duePanel(app) {
  const store = app.store;
  const items = outstandingItems(store);
  const selected = new Map();
  const total = items.reduce((t, i) => t + i.outstanding, 0);
  const bar = h("div", { class: "actions sticky hide" });
  const updateBar = () => {
    const sum = [...selected.values()].reduce((t, i) => t + i.outstanding, 0);
    bar.classList.toggle("hide", selected.size < 2);
    add(clear(bar), h("span", null, `${selected.size} selected · ${money(sum)}`), h("button", { class: "btn primary", onclick: () => multiPay(app, [...selected.values()]) }, "Receive together"));
  };
  return h(
    "div",
    null,
    h("div", { class: "card" }, h("div", { class: "kv total" }, h("span", null, "Patient balances outstanding"), h("b", null, money(total))), h("p", { class: "muted small" }, "Fees at locations where patients pay you directly. Hospital-collected fees appear under Hospitals."), h("button", { class: "btn small", onclick: () => advanceDialog(app) }, "Record advance / unallocated receipt")),
    items.length ? null : h("p", { class: "muted" }, "Nothing outstanding. ✓"),
    items.map((i) =>
      h(
        "div",
        { class: "row" },
        h("input", { type: "checkbox", "aria-label": "select", onchange: (e) => { e.target.checked ? selected.set(i.type + i.id, i) : selected.delete(i.type + i.id); updateBar(); } }),
        h("div", { class: "grow click", onclick: () => app.go("session", { id: i.s.id }) }, h("b", null, i.label), h("div", { class: "muted small" }, date(i.date), " · ", store.locationName(i.s.locationId), " · ", cap(i.s.sessionName))),
        h("div", { class: "right" }, h("b", null, money(i.outstanding)), h("button", { class: "btn small primary", onclick: () => payDialog(app, i.type, i.id, i.outstanding) }, "Receive")),
      ),
    ),
    bar,
  );
}

function multiPay(app, items) {
  const store = app.store;
  const total = items.reduce((t, i) => t + i.outstanding, 0);
  let method = "cash";
  const d = dateInput(today());
  const ref = h("input", { type: "text", placeholder: "Reference (optional)" });
  const err = h("div", { class: "err" });
  return modal("Receive payment for " + items.length + " items", [h("p", null, "Total ", h("b", null, money(total)), " — each item is settled in full."), field("paymentMethod", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), method, (v) => (method = v))), field("Payment date", d), field("reference", ref), err], [
    { label: "Cancel", result: false },
    {
      label: "Save payment",
      kind: "primary",
      value: () =>
        store
          .recordPatientPayment({ date: d.value, method, amountPaise: total, reference: ref.value, allocations: items.map((i) => ({ targetType: i.type, targetId: i.id, amountPaise: i.outstanding })) })
          .then(() => { toast("Payment saved ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

function advanceDialog(app) {
  const store = app.store;
  const amt = moneyInput();
  let method = "cash";
  let loc = store.settings.lastLocationId || store.locationsSorted()[0]?.id;
  const d = dateInput(today());
  const ref = h("input", { type: "text", placeholder: "Reference (optional)" });
  const notes = h("input", { type: "text", placeholder: "Note (e.g. advance for next visit)" });
  const err = h("div", { class: "err" });
  return modal("Advance / unallocated receipt", [h("p", { class: "small muted" }, "Money received that is not for a recorded visit yet. It counts as a collection on its date and is shown as an advance."), field("amountReceived", amt), field("location", select(store.locationsSorted().map((l) => ({ value: l.id, label: l.name })), loc, (v) => (loc = v))), field("paymentMethod", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), method, (v) => (method = v))), field("Payment date", d), field("reference", ref), notes, err], [
    { label: "Cancel", result: false },
    {
      label: "Save",
      kind: "primary",
      value: () =>
        store
          .recordPatientPayment({ date: d.value, method, amountPaise: amt.paise(), reference: ref.value, allocations: [], advance: true, locationId: loc, notes: notes.value })
          .then(() => { toast("Advance recorded ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

function paymentsPanel(app) {
  const store = app.store;
  const f = { from: addDays(today(), -30), to: today() };
  const list = h("div");
  const draw = () => {
    clear(list);
    const ps = store.data.payments.filter((p) => p.date >= f.from && p.date <= f.to).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    if (!ps.length) add(list, h("p", { class: "muted" }, "No payments in this period."));
    for (const p of ps) {
      const who = p.payerType === "hospital" ? store.payerName(p.payerId) : p.locationId ? store.locationName(p.locationId) : "Patient";
      add(list, 
        h(
          "div",
          { class: "row" + (p.voided ? " struck" : "") },
          h("div", { class: "grow click", onclick: () => p.sessionId && app.go("session", { id: p.sessionId }) }, h("b", null, (p.kind === "refund" ? "Refund · " : "") + (p.payerType === "hospital" ? "Hospital · " : "") + who), h("div", { class: "muted small" }, date(p.date), " · ", METHODS[p.method], p.reference ? " · " + p.reference : "", p.origin === "summary" ? " · session summary" : "", p.advance ? " · advance" : "", p.voided ? " · VOID: " + (p.voidReason || "") : "")),
          h("div", { class: "right" }, h("b", null, (p.kind === "refund" ? "−" : "") + money(p.amountPaise)), !p.voided && p.origin !== "summary" ? h("button", { class: "link small", onclick: async () => {
            const r = await askReason("Void payment?", "Reverses a payment entered by mistake. The record is kept, marked void.", { ok: "Void", danger: true });
            if (r === null) return;
            if (await attempt(() => store.voidPayment(p.id, r).then(() => true))) draw();
          } }, "Void") : null),
        ),
      );
    }
  };
  draw();
  return h("div", null, h("div", { class: "card filters grid2" }, field("From", dateInput(f.from, (v) => { f.from = v; draw(); })), field("To", dateInput(f.to, (v) => { f.to = v; draw(); }))), list);
}

// ------------------------------------------------------------------ hospitals

export function describeAgreement(a) {
  if (!a) return "No agreement set";
  const pct = bpToPct(a.pctBp) + "% of " + (a.base === "net" ? "net fees" : a.base === "collected" ? "hospital collections" : a.base === "custom" ? "defined base" : "gross fees");
  const parts = {
    fixed: `Salary ${money(a.salaryPaise)}`,
    pct,
    min: `Minimum ${money(a.minPaise)}`,
    max_min_pct: `Higher of ${money(a.minPaise)} or ${pct}`,
    min_plus_pct: `${money(a.minPaise)} + ${pct}`,
    salary_plus_pct: `Salary ${money(a.salaryPaise)} + ${pct}`,
    manual: "Amount entered per settlement",
  };
  return `${parts[a.type]} · ${FREQUENCIES[a.frequency].toLowerCase()}, due ${a.dueAfterDays} days after period end`;
}

function hospitalsPanel(app) {
  const store = app.store;
  const payers = [...store.data.payers].sort((a, b) => a.name.localeCompare(b.name));
  return h(
    "div",
    null,
    h("button", { class: "btn", onclick: () => payerDialog(app) }, "+ Add hospital"),
    payers.length ? null : h("p", { class: "muted" }, "No hospitals yet. Add one for locations where the hospital collects fees or pays you a salary/share."),
    payers.map((p) => {
      const ag = agreementFor(store.data.agreements, p.id, today());
      let bal = 0;
      for (const s of store.data.settlements.filter((s) => s.payerId === p.id && !s.voided)) bal += store.settlementView(s.id).balance;
      return h("button", { class: "row click", onclick: () => app.go("hospital", { id: p.id }) }, h("div", null, h("b", null, p.name, p.active === false ? " (inactive)" : ""), h("div", { class: "muted small" }, describeAgreement(ag))), h("div", { class: "right" }, h("b", null, money(bal)), h("div", { class: "small muted" }, "balance due")));
    }),
  );
}

function payerDialog(app, payer) {
  const name = h("input", { type: "text", value: payer ? payer.name : "", placeholder: "Hospital name" });
  const err = h("div", { class: "err" });
  return modal(payer ? "Rename hospital" : "Add hospital", [field("hospital", name), err], [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => app.store.savePayer({ ...(payer || {}), name: name.value }).then(() => { app.render(); return true; }).catch((e) => { err.textContent = e.message; return undefined; }) },
  ]);
}

export function renderHospital(app, { id }) {
  const store = app.store;
  const p = store.get("payers", id);
  if (!p) return h("div", { class: "screen" }, "Hospital not found.");
  const ags = store.data.agreements.filter((a) => a.payerId === id && !a.voided).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const current = agreementFor(store.data.agreements, id, today());
  const locs = store.data.locations.filter((l) => l.payerId === id);
  const sts = store.data.settlements.filter((s) => s.payerId === id && !s.voided).sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  return h(
    "div",
    { class: "screen" },
    h("h1", null, p.name),
    h("div", { class: "row-btns" }, h("button", { class: "btn small", onclick: () => payerDialog(app, p) }, "Rename"), h("button", { class: "btn small", onclick: () => attempt(() => store.savePayer({ ...p, active: p.active === false })).then(() => app.render()) }, p.active === false ? "Activate" : "Deactivate")),
    h("div", { class: "card" }, h("h3", null, "Locations"), locs.length ? locs.map((l) => h("div", null, l.name, " · ", l.arrangement === "mixed" ? "mixed" : "hospital collects")) : h("p", { class: "muted small" }, "No locations linked. Link them in More → Locations & fees.")),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Agreement"),
      h("p", null, h("b", null, describeAgreement(current))),
      h("p", { class: "muted small" }, "A percentage is applied only as configured here, and only to sessions where the hospital collected the fees. Salary and minimum amounts are per settlement period."),
      h("button", { class: "btn small", onclick: () => agreementDialog(app, id, current) }, current ? "Change agreement (new effective date)" : "Set agreement"),
      ags.length > 1 ? h("details", null, h("summary", null, "History"), ags.map((a) => h("div", { class: "small" }, "From ", date(a.effectiveFrom), ": ", describeAgreement(a)))) : null,
    ),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Settlement periods"),
      h("button", { class: "btn primary small", onclick: () => settlementDialog(app, id, current) }, "+ New settlement period"),
      sts.map((s) => {
        const v = store.settlementView(s.id);
        return h("button", { class: "row click", onclick: () => app.go("settlement", { id: s.id }) }, h("div", null, h("b", null, date(s.periodStart), " – ", date(s.periodEnd)), h("div", { class: "small muted" }, "Payable ", money(v.calc.total), " · paid ", money(v.paid), s.finalized ? "" : " · provisional")), h("div", { class: "right" }, h("b", null, money(v.balance)), badge(STATUS_LABEL[v.status], v.status === "paid" ? "ok" : v.status.includes("overdue") ? "bad" : "warn")));
      }),
    ),
  );
}

function agreementDialog(app, payerId, cur) {
  const st = { type: cur ? cur.type : "max_min_pct", base: cur ? cur.base || "gross" : "gross", frequency: cur ? cur.frequency : "monthly" };
  const eff = dateInput(today().slice(0, 8) + "01");
  const pct = h("input", { type: "text", inputmode: "decimal", value: cur ? bpToPct(cur.pctBp) : "", placeholder: "e.g. 30" });
  const sal = moneyInput({ value: cur ? cur.salaryPaise || null : null });
  const min = moneyInput({ value: cur ? cur.minPaise || null : null });
  const due = h("input", { type: "number", min: 0, max: 120, value: cur ? cur.dueAfterDays : 10 });
  const notes = h("input", { type: "text", value: cur ? cur.notes : "" });
  const dyn = h("div");
  const err = h("div", { class: "err" });
  const draw = () => {
    clear(dyn);
    const t = st.type;
    if (["fixed", "salary_plus_pct"].includes(t)) add(dyn, field("Fixed salary per period ₹", sal));
    if (["min", "max_min_pct", "min_plus_pct"].includes(t)) add(dyn, field("Minimum guaranteed per period ₹", min));
    if (["pct", "max_min_pct", "min_plus_pct", "salary_plus_pct"].includes(t)) add(dyn, field("Revenue share %", pct), field("Percentage applies to", select(Object.entries(REVENUE_BASES).map(([value, label]) => ({ value, label })), st.base, (v) => (st.base = v))));
  };
  draw();
  return modal("Hospital agreement", [
    field("Agreement type", select(Object.entries(AGREEMENT_TYPES).map(([value, label]) => ({ value, label })), st.type, (v) => { st.type = v; draw(); })),
    dyn,
    field("Settlement frequency", select(Object.entries(FREQUENCIES).map(([value, label]) => ({ value, label })), st.frequency, (v) => (st.frequency = v))),
    field("Payment due (days after period end)", due),
    field("Effective from", eff),
    h("small", { class: "hint" }, "Earlier periods keep the agreement that applied to them."),
    field("Notes", notes),
    err,
  ], [
    { label: "Cancel", result: false },
    {
      label: "Save agreement",
      kind: "primary",
      value: () =>
        app.store
          .saveAgreement({ payerId, type: st.type, base: st.base, frequency: st.frequency, pctBp: pctToBp(pct.value), salaryPaise: sal.paise(), minPaise: min.paise(), dueAfterDays: Number(due.value), effectiveFrom: eff.value, notes: notes.value })
          .then(() => { toast("Agreement saved ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

function settlementDialog(app, payerId, ag) {
  const freq = ag ? ag.frequency : "monthly";
  // Default: the last completed period.
  const prev = periodFor(freq, today());
  const p = periodFor(freq, addDays(prev.from, -1));
  const from = dateInput(p.from);
  const to = dateInput(p.to);
  const notes = h("input", { type: "text" });
  const err = h("div", { class: "err" });
  return modal("New settlement period", [field("Period start", from), field("Period end", to), field("Notes", notes), err], [
    { label: "Cancel", result: false },
    {
      label: "Create",
      kind: "primary",
      value: () =>
        app.store
          .saveSettlement({ payerId, periodStart: from.value, periodEnd: to.value, notes: notes.value })
          .then((st) => { app.go("settlement", { id: st.id }); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

export function renderSettlement(app, { id }) {
  const store = app.store;
  const s = store.get("settlements", id);
  if (!s) return h("div", { class: "screen" }, "Settlement not found.");
  const v = store.settlementView(id);
  const c = v.calc;
  const needsBase = v.agreement && (v.agreement.base === "collected" || v.agreement.base === "custom") && ["pct", "max_min_pct", "min_plus_pct", "salary_plus_pct"].includes(v.agreement.type);
  const isManual = !v.agreement || v.agreement.type === "manual";
  const baseIn = moneyInput({ value: s.reportedBasePaise });
  const manIn = moneyInput({ value: s.manualAmountPaise });
  const pays = store.data.payments.filter((p) => !p.voided && p.payerType === "hospital" && (store.ledger.allocByPayment.get(p.id) || []).some((a) => a.targetId === id));
  const adjs = (store.ledger.adjByTarget.get("settlement:" + id) || []).filter((a) => !a.voided);
  const rerender = () => app.go("settlement", { id }, { replace: true });
  const saveFigures = async () => {
    if (await attempt(() => store.saveSettlement({ ...s, reportedBasePaise: needsBase ? baseIn.paise() : s.reportedBasePaise, manualAmountPaise: isManual ? manIn.paise() : s.manualAmountPaise }, "Figures entered"))) rerender();
  };
  return h(
    "div",
    { class: "screen" },
    h("h1", null, store.payerName(s.payerId)),
    h("div", null, "Period ", date(s.periodStart), " – ", date(s.periodEnd), " · due ", date(v.dueDate)),
    h("div", { class: "badges" }, badge(STATUS_LABEL[v.status], v.status === "paid" ? "ok" : v.status.includes("overdue") ? "bad" : "warn"), s.finalized ? badge("Finalised " + fmtDateTime(s.finalized.at), "mid") : badge("Provisional — updates with your records", "mid")),
    h(
      "div",
      { class: "card totals" },
      h("p", { class: "small" }, "Agreement: ", h("b", null, describeAgreement(v.agreement)), h("br"), "Formula: ", c.formula),
      h("div", { class: "kv" }, h("span", null, "Hospital-collected sessions"), h("b", null, `${c.eligible ? c.eligible.sessions : "—"} sessions · ${c.eligible ? c.eligible.visits : "—"} patients`)),
      c.eligible ? h("div", { class: "kv" }, h("span", null, "Gross / net fees (my records)"), h("b", null, money(c.eligible.gross), " / ", money(c.eligible.net))) : null,
      c.pctBp ? h("div", { class: "kv" }, h("span", null, "Eligible revenue base"), h("b", null, money(c.base))) : null,
      c.pctBp ? h("div", { class: "kv" }, h("span", null, `Revenue share (${bpToPct(c.pctBp)}%)`), h("b", null, money(c.share))) : null,
      c.salary ? h("div", { class: "kv" }, h("span", null, "Salary"), h("b", null, money(c.salary))) : null,
      c.minimum ? h("div", { class: "kv" }, h("span", null, "Minimum guarantee"), h("b", null, money(c.minimum))) : null,
      h("div", { class: "kv" }, h("span", null, "Amount under agreement"), h("b", null, money(c.amount))),
      h("div", { class: "kv" }, h("span", null, "Adjustments"), h("b", null, money(c.adjustments, { sign: true }))),
      h("div", { class: "kv total" }, h("span", null, "Total payable to me"), h("b", null, money(c.total))),
      h("div", { class: "kv" }, h("span", null, "Received from hospital"), h("b", null, money(v.paid))),
      h("div", { class: "kv total" + (v.balance > 0 ? " due" : "") }, h("span", null, "Balance due"), h("b", null, money(v.balance))),
      v.drift ? h("p", { class: "badc small" }, `Your records have changed since this was finalised: the live calculation is now ${money(v.live.total)} (${money(v.drift, { sign: true })}). Unlock to recalculate.`) : null,
    ),
    !s.finalized && (needsBase || isManual)
      ? h("div", { class: "card" }, needsBase ? field(v.agreement.base === "collected" ? "Fees collected by hospital (from hospital statement) ₹" : "Defined revenue base for this period ₹", baseIn) : null, isManual ? field("Settlement amount ₹", manIn) : null, h("button", { class: "btn", onclick: saveFigures }, "Save figures"))
      : null,
    h(
      "div",
      { class: "row-btns wrap" },
      v.balance > 0 || !pays.length ? h("button", { class: "btn primary", onclick: () => hospitalPayDialog(app, s, v) }, "Record hospital payment") : null,
      h("button", { class: "btn", onclick: () => settlementAdjDialog(app, s) }, "Adjustment (TDS, deduction, bonus)"),
      s.finalized
        ? h("button", { class: "btn", onclick: async () => { const r = await askReason("Unlock settlement", "Why recalculate this finalised settlement?"); if (r !== null && (await attempt(() => store.unfinalizeSettlement(id, r).then(() => true)))) rerender(); } }, "Unlock")
        : h("button", { class: "btn", onclick: async () => { if ((await confirmDialog("Finalise settlement", `Lock the calculated amount of ${money(v.live.amount)}? Later changes to visits will be flagged instead of silently changing it.`)) && (await attempt(() => store.finalizeSettlement(id).then(() => true)))) rerender(); } }, "Finalise"),
      h("button", { class: "btn danger-o", onclick: async () => { const r = await askReason("Void settlement period", "", { ok: "Void", danger: true }); if (r !== null && (await attempt(() => store.voidSettlement(id, r).then(() => true)))) app.back(); } }, "Void"),
    ),
    adjs.length ? h("div", { class: "card" }, h("h3", null, "Adjustments"), adjs.map((a) => h("div", { class: "kv" }, h("span", null, date(a.date), " · ", a.reason), h("b", null, money(a.amountPaise, { sign: true }))))) : null,
    pays.length ? h("div", { class: "card" }, h("h3", null, "Payments received"), pays.map((p) => h("div", { class: "kv" }, h("span", null, date(p.date), " · ", METHODS[p.method], p.reference ? " · " + p.reference : "", p.advance ? " · includes advance" : ""), h("b", null, money(p.amountPaise))))) : null,
    s.notes ? h("p", { class: "small muted" }, s.notes) : null,
  );
}

function hospitalPayDialog(app, s, v) {
  const amt = moneyInput({ value: v.balance > 0 ? v.balance : null });
  let method = "bank";
  const d = dateInput(today());
  const ref = h("input", { type: "text", placeholder: "NEFT/UTR/cheque no." });
  const adv = h("input", { type: "checkbox" });
  const err = h("div", { class: "err" });
  return modal("Payment from " + app.store.payerName(s.payerId), [h("p", null, "Balance due ", h("b", null, money(v.balance))), field("amountReceived", amt), field("paymentMethod", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), method, (x) => (method = x))), field("Payment date", d), field("reference", ref), h("label", { class: "check" }, adv, " Excess over balance is an advance"), err], [
    { label: "Cancel", result: false },
    {
      label: "Save",
      kind: "primary",
      value: () =>
        app.store
          .recordHospitalPayment({ settlementId: s.id, date: d.value, method, amountPaise: amt.paise(), reference: ref.value, advance: adv.checked })
          .then(() => { toast("Hospital payment saved ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

function settlementAdjDialog(app, s) {
  const amt = moneyInput({ allowNegative: true });
  const reason = h("input", { type: "text", placeholder: "e.g. TDS 10%, short payment agreed, bonus" });
  const err = h("div", { class: "err" });
  return modal("Settlement adjustment", [field("Amount ₹ (negative reduces what is payable)", amt), field("reason", reason), err], [
    { label: "Cancel", result: false },
    {
      label: "Save",
      kind: "primary",
      value: () =>
        app.store
          .addAdjustment({ targetType: "settlement", targetId: s.id, type: "settlement", amountPaise: amt.paise(), reason: reason.value })
          .then(() => { app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; }),
    },
  ]);
}

export { adjustDialog, addMonths };
