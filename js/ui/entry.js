// Quick session summary and individual patient entry.
import { h, add, clear, money, date, field, moneyInput, dateInput, stepper, segmented, toast, confirmDialog, askReason, attempt, badge } from "./dom.js";
import { L, T } from "../i18n.js";
import { today } from "../dates.js";
import { rateFor } from "../calc.js";
import { METHODS, SESSION_NAMES } from "../model.js";
import { sum } from "../money.js";

export function renderAdd(app) {
  const recent = [...app.store.data.sessions].filter((s) => !s.voided).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  return h(
    "div",
    { class: "screen" },
    h("h1", null, L("add")),
    h("button", { class: "choice", onclick: () => app.go("summary") }, h("b", null, L("quickSummary")), h("span", null, "Counts of new and follow-up patients for a completed OPD/round, with totals collected. Fastest.")),
    h("button", { class: "choice", onclick: () => app.go("visit") }, h("b", null, L("individualEntry")), h("span", null, "One visit at a time: fee, discount, payment. Patient ID and name are optional.")),
    recent.length ? h("h3", { class: "sec" }, "Recent sessions") : null,
    recent.map((s) => sessionRow(app, s)),
  );
}

export function sessionRow(app, s) {
  const f = app.store.ledger.sessionFin.get(s.id);
  if (!f) return null;
  return h(
    "button",
    { class: "row click", onclick: () => app.go("session", { id: s.id }) },
    h("div", null, h("b", null, app.store.locationName(s.locationId)), h("div", { class: "muted small" }, date(s.date), " · ", cap(s.sessionName), s.collector === "hospital" ? " · hospital collects" : "")),
    h("div", { class: "right" }, h("b", null, f.eff.visits + " pts"), h("div", { class: "small" }, money(f.eff.net)), f.needsRecon ? badge("Reconcile", "warn") : s.status === "reconciled" ? badge("Reconciled", "ok") : s.mode === "summary" ? badge("Summary", "mid") : null),
  );
}

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// Date, location and session pickers shared by both entry screens.
function contextPicker(app, st, onchange) {
  const locs = app.store.locationsSorted();
  const wrap = h("div", { class: "card" });
  const draw = () => {
    clear(wrap);
    const loc = app.store.get("locations", st.locationId);
    const named = SESSION_NAMES.includes(st.sessionName);
    const custom = h("input", { type: "text", placeholder: "e.g. Camp, Night round", value: named ? "" : st.sessionName, oninput: (e) => { st.sessionName = e.target.value.trim().toLowerCase(); onchange("session"); } });
    add(wrap, 
      field("date", dateInput(st.date, (v) => { st.date = v; onchange("date"); })),
      field("location", h("div", { class: "pills" }, locs.map((l) => h("button", { type: "button", class: "pill" + (l.id === st.locationId ? " on" : ""), onclick: () => { st.locationId = l.id; draw(); onchange("location"); } }, l.name)))),
      field("session", segmented([...SESSION_NAMES.map((n) => ({ value: n, label: L(n) })), { value: "custom", label: L("custom") }], named ? st.sessionName : "custom", (v) => { st.sessionName = v === "custom" ? "" : v; draw(); onchange("session"); })),
      named ? null : field("Custom session name", custom),
      loc && loc.arrangement === "mixed"
        ? field("Who collects the fees?", segmented([{ value: "me", label: "I collect" }, { value: "hospital", label: "Hospital collects" }], st.collector, (v) => { st.collector = v; onchange("collector"); }))
        : loc ? h("p", { class: "muted small" }, loc.arrangement === "hospital" ? "Hospital collects fees here; patient payments are settled through the hospital." : "Patients pay me directly here.") : null,
    );
    if (!locs.length) add(wrap, h("p", { class: "err" }, "No active locations. Add one in More → Locations & fees."));
  };
  draw();
  return wrap;
}

function collectorOf(app, st) {
  const loc = app.store.get("locations", st.locationId);
  if (!loc) return "me";
  if (loc.arrangement === "direct") return "me";
  if (loc.arrangement === "hospital") return "hospital";
  return st.collector;
}

function initialContext(app) {
  const s = app.store.settings;
  const locs = app.store.locationsSorted();
  const last = locs.find((l) => l.id === s.lastLocationId);
  return { date: today(), locationId: last ? last.id : locs[0] && locs[0].id, sessionName: s.lastSessionName || "morning", collector: "me" };
}

async function remember(app, st) {
  await app.store.saveSettings({ lastLocationId: st.locationId, lastSessionName: st.sessionName });
}

async function confirmDuplicate(app, dups, what) {
  const list = dups.map((d) => `${date(d.date)} · ${d.patientId || app.store.locationName(d.locationId)} · ${d.id}`).join("\n");
  return confirmDialog("Possible duplicate", `A ${what} with the same details already exists:\n${list}\n\nSave anyway? Only do this if it is a genuine separate entry.`, { ok: "Save as separate entry" });
}

// ------------------------------------------------------------------- summary

export function renderSummaryForm(app, params) {
  const store = app.store;
  const editing = params.id ? store.get("sessions", params.id) : null;
  const st = editing
    ? { date: editing.date, locationId: editing.locationId, sessionName: editing.sessionName, collector: editing.collector, mode: editing.mode === "summary" ? "summary" : "summary_recon" }
    : { ...initialContext(app), mode: "summary" };
  let lines = editing ? structuredClone(editing.summary.lines) : [];
  let manual = editing ? editing.summary.grossOverridePaise !== null : false;
  const prevCol = { cash: 0, upi: 0, bank: 0, other: 0 };
  const prevRef = {};
  if (editing) {
    for (const p of store.data.payments.filter((p) => p.origin === "summary" && p.sessionId === editing.id && !p.voided)) {
      prevCol[p.method] += p.amountPaise;
      prevRef[p.method] = p.reference;
    }
  }

  const root = h("div", { class: "screen", dataset: { dirty: "0" } });
  const linesBox = h("div");
  const totalsBox = h("div", { class: "card totals" });
  const grossIn = moneyInput({ value: editing ? editing.summary.grossOverridePaise : null, oninput: () => recalc() });
  const discIn = moneyInput({ value: editing ? editing.summary.discountPaise : null, oninput: () => recalc() });
  const colIns = Object.fromEntries(Object.keys(METHODS).map((m) => [m, moneyInput({ value: prevCol[m] || null, oninput: () => recalc() })]));
  const refIns = Object.fromEntries(["upi", "bank", "other"].map((m) => [m, h("input", { type: "text", placeholder: "Ref (optional)", value: prevRef[m] || "" })]));
  const colBox = h("div", { class: "card" });
  const remarks = h("textarea", { rows: 2, value: editing ? editing.remarks : "" });
  const msg = h("div", { class: "err" });

  const loadLines = () => {
    const rate = rateFor(store.data.rates, st.locationId, st.date);
    const old = new Map(lines.map((l) => [l.key, l]));
    lines = rate ? rate.categories.map((c) => ({ key: c.key, label: c.label, feePaise: c.feePaise, isVisit: c.isVisit, count: old.get(c.key)?.count || 0 })) : [];
    drawLines();
  };

  const drawLines = () => {
    clear(linesBox);
    if (!lines.length) {
      add(linesBox, h("p", { class: "err" }, "No fees set for this location on this date. Add them in More → Locations & fees."));
      return;
    }
    add(linesBox, 
      h(
        "div",
        { class: "card" },
        h("div", { class: "line head" }, h("span", null, L("visitType")), h("span", null, L("fee"), " ₹"), h("span", null, L("patients")), h("span", null, "Total")),
        lines.map((l) => {
          const feeIn = moneyInput({ value: l.feePaise, oninput: () => { l.feePaise = feeIn.paise() ?? 0; recalc(); } });
          const tot = h("b", { class: "lt" });
          l._tot = tot;
          return h("div", { class: "line" }, h("span", null, l.key === "new" ? L("newPatients") : l.key === "followup" ? L("followups") : l.label, l.isVisit ? null : h("small", { class: "muted" }, " (not a visit)")), feeIn, stepper(l.count, (n) => { l.count = n; recalc(); }), tot);
        }),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: manual, onchange: (e) => { manual = e.target.checked; recalc(); } }), " Enter gross total manually (exact fees unknown)"),
        h("div", { class: "manual-gross" }, field("grossFees", grossIn)),
        field("discounts", discIn),
      ),
    );
    recalc();
  };

  const drawCollections = () => {
    clear(colBox);
    if (collectorOf(app, st) === "hospital") {
      add(colBox, h("p", { class: "muted" }, "The hospital collects fees for this session. Record what it pays you under Money → Hospitals."));
      return;
    }
    add(colBox, 
      h("h3", null, L("collections")),
      h("div", { class: "row-btns" }, h("button", { type: "button", class: "btn small", onclick: () => { for (const m in colIns) colIns[m].setPaise(0); colIns.cash.setPaise(net()); recalc(); } }, "All cash"), h("button", { type: "button", class: "btn small", onclick: () => { for (const m in colIns) colIns[m].setPaise(0); colIns.upi.setPaise(net()); recalc(); } }, "All UPI"), h("button", { type: "button", class: "btn small", onclick: () => { for (const m in colIns) colIns[m].setPaise(0); recalc(); } }, "Nothing collected")),
      h("div", { class: "grid2" }, field("cash", colIns.cash), field("upi", h("div", null, colIns.upi, refIns.upi)), field("bank", h("div", null, colIns.bank, refIns.bank)), field("other", h("div", null, colIns.other, refIns.other))),
    );
  };

  const lineGross = () => sum(lines, (l) => l.count * l.feePaise);
  const gross = () => (manual ? grossIn.paise() ?? 0 : lineGross());
  const net = () => gross() - (discIn.paise() ?? 0);

  function recalc() {
    root.dataset.dirty = "1";
    for (const l of lines) if (l._tot) l._tot.textContent = money(l.count * l.feePaise);
    root.querySelector(".manual-gross")?.classList.toggle("hide", !manual);
    const visits = sum(lines.filter((l) => l.isVisit), (l) => l.count);
    const nw = sum(lines.filter((l) => l.key === "new"), (l) => l.count);
    const fu = sum(lines.filter((l) => l.key === "followup"), (l) => l.count);
    const hosp = collectorOf(app, st) === "hospital";
    const col = hosp ? 0 : sum(Object.values(colIns), (i) => i.paise() ?? 0);
    const n = net();
    add(clear(totalsBox), 
      h("div", { class: "kv" }, h("span", null, L("patients")), h("b", null, `${visits}  (${nw} new · ${fu} follow-up${visits - nw - fu ? " · " + (visits - nw - fu) + " other" : ""})`)),
      h("div", { class: "kv" }, h("span", null, L("grossFees")), h("b", null, money(gross()), manual && gross() !== lineGross() ? h("small", { class: "muted" }, ` (lines: ${money(lineGross())})`) : null)),
      h("div", { class: "kv" }, h("span", null, L("discounts")), h("b", null, "−" + money(discIn.paise() ?? 0))),
      h("div", { class: "kv total" }, h("span", null, L("netFees")), h("b", null, money(n))),
      hosp ? h("div", { class: "kv" }, h("span", null, "Collected by"), h("b", null, "Hospital")) : [h("div", { class: "kv" }, h("span", null, L("collected")), h("b", null, money(col))), h("div", { class: "kv " + (n - col < 0 ? "bad" : "") }, h("span", null, L("unpaid")), h("b", null, money(n - col)))],
    );
  }

  const save = async () => {
    msg.textContent = "";
    const bad = [grossIn, discIn, ...Object.values(colIns)].find((i) => i.paise() === null);
    if (bad) return (msg.textContent = "Check the highlighted amount.");
    if (!st.sessionName) return (msg.textContent = "Enter a session name.");
    const hosp = collectorOf(app, st) === "hospital";
    const input = {
      id: editing ? editing.id : undefined,
      date: st.date,
      locationId: st.locationId,
      sessionName: st.sessionName,
      mode: st.mode,
      collector: st.collector,
      lines: lines.map(({ _tot, ...l }) => l),
      grossOverridePaise: manual ? grossIn.paise() : null,
      discountPaise: discIn.paise(),
      collections: hosp ? {} : Object.fromEntries(Object.entries(colIns).map(([m, i]) => [m, i.paise()])),
      references: Object.fromEntries(Object.entries(refIns).map(([m, i]) => [m, i.value])),
      remarks: remarks.value,
    };
    let reason = "";
    if (editing) {
      reason = await askReason("Why are you changing this summary?", "Recorded in the audit log.");
      if (reason === null) return;
    }
    const res = await attempt(async () => {
      let r = await store.saveSummarySession(input, { reason });
      if (r.needsConfirm) {
        if (!(await confirmDuplicate(app, r.duplicates, "session"))) return null;
        r = await store.saveSummarySession(input, { allowDuplicate: true });
      }
      return r;
    });
    if (!res) return;
    root.dataset.dirty = "0";
    await remember(app, st);
    toast(editing ? "Summary updated ✓ Saved" : "Session saved ✓");
    app.go("session", { id: res.session.id }, { replace: true });
  };

  add(root, 
    h("h1", null, editing ? "Edit session summary" : L("quickSummary")),
    editing ? h("p", { class: "muted small" }, editing.id) : null,
    editing
      ? h("div", { class: "card" }, h("b", null, store.locationName(st.locationId)), " · ", date(st.date), " · ", cap(st.sessionName))
      : contextPicker(app, st, (what) => {
          if (what === "location" || what === "date") loadLines();
          if (what === "location" || what === "collector") drawCollections();
          recalc();
        }),
    field("How will this session be recorded?", segmented([{ value: "summary", label: "Summary only" }, { value: "summary_recon", label: "Summary now, individual entries later" }], st.mode, (v) => (st.mode = v))),
    linesBox,
    colBox,
    totalsBox,
    field("remarks", remarks),
    msg,
    h("div", { class: "actions sticky" }, h("button", { class: "btn", onclick: () => app.back() }, "Cancel"), h("button", { class: "btn primary big", onclick: save }, L("save"))),
  );
  if (editing) drawLines();
  else loadLines();
  drawCollections();
  recalc();
  root.dataset.dirty = "0";
  return root;
}

// ------------------------------------------------------------- individual entry

export function renderVisitForm(app, params) {
  const store = app.store;
  const fixed = params.sessionId ? store.get("sessions", params.sessionId) : null;
  const st = fixed ? { date: fixed.date, locationId: fixed.locationId, sessionName: fixed.sessionName, collector: fixed.collector } : initialContext(app);
  const form = { category: "new", payState: "full", method: "cash" };
  const root = h("div", { class: "screen", dataset: { dirty: "0" } });
  const savedInfo = h("div");
  const pid = h("input", { type: "text", autocomplete: "off", placeholder: "e.g. OPD no. / UHID" });
  const pname = h("input", { type: "text", autocomplete: "off" });
  const typeBox = h("div");
  const feeIn = moneyInput({ oninput: () => recalc() });
  const overrideBox = h("div", { class: "hide" });
  const overrideReason = h("input", { type: "text", placeholder: "Why is the fee different?" });
  add(overrideBox, field("Reason for fee change", overrideReason));
  const discIn = moneyInput({ oninput: () => recalc() });
  const discType = segmented([{ value: "discount", label: "Discount" }, { value: "waiver", label: "Waiver" }], "discount", (v) => (form.discType = v));
  form.discType = "discount";
  const discReason = h("input", { type: "text", placeholder: "Reason (required for a discount)" });
  const discBox = h("div", { class: "hide" }, field("", discType), field("reason", discReason));
  const netOut = h("div", { class: "card totals" });
  const payBox = h("div", { class: "card" });
  const amtIn = moneyInput({ oninput: () => recalc() });
  const payDate = dateInput(st.date);
  const refIn = h("input", { type: "text", placeholder: "UPI / bank reference (optional)" });
  const remarks = h("input", { type: "text", placeholder: "Administrative note (no medical details)" });
  const msg = h("div", { class: "err" });

  let rate = null;
  const loadRate = () => {
    rate = rateFor(store.data.rates, st.locationId, st.date);
    clear(typeBox);
    if (!rate) {
      add(typeBox, h("p", { class: "err" }, "No fees set for this location on this date. Add them in More → Locations & fees."));
      return;
    }
    if (!rate.categories.find((c) => c.key === form.category)) form.category = rate.categories[0].key;
    add(typeBox, 
      field("visitType", segmented(rate.categories.map((c) => ({ value: c.key, label: c.key === "new" ? L("newPatients") : c.key === "followup" ? L("followups") : c.label })), form.category, (v) => { form.category = v; feeIn.setPaise(stdFee()); recalc(); }, { cls: "big" })),
    );
    feeIn.setPaise(stdFee());
    payDate.value = st.date;
    recalc();
  };
  const stdFee = () => (rate ? rate.categories.find((c) => c.key === form.category)?.feePaise ?? 0 : 0);
  const hosp = () => collectorOf(app, st) === "hospital";

  const drawPay = () => {
    clear(payBox);
    if (hosp()) {
      add(payBox, h("p", { class: "muted" }, "Hospital collects fees for this session — no patient payment is recorded here."));
      return;
    }
    add(payBox, 
      h("h3", null, "Payment"),
      segmented([{ value: "full", label: "Paid in full" }, { value: "part", label: "Part paid" }, { value: "none", label: "Unpaid" }], form.payState, (v) => { form.payState = v; drawPay(); recalc(); }, { cls: "big" }),
      form.payState === "none" ? null : field("paymentMethod", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), form.method, (v) => { form.method = v; drawPay(); })),
      form.payState === "part" ? field("amountReceived", amtIn) : null,
      form.payState === "none" ? null : h("div", { class: "grid2" }, field("Payment date", payDate), form.method === "cash" ? null : field("reference", refIn)),
    );
  };

  const fee = () => feeIn.paise() ?? 0;
  const disc = () => discIn.paise() ?? 0;
  function recalc() {
    root.dataset.dirty = "1";
    overrideBox.classList.toggle("hide", fee() === stdFee());
    discBox.classList.toggle("hide", !disc());
    const n = fee() - disc();
    const paid = hosp() ? 0 : form.payState === "full" ? n : form.payState === "part" ? amtIn.paise() ?? 0 : 0;
    const status = hosp() ? "Hospital collects" : n === 0 && disc() > 0 ? "Waived" : paid >= n && n > 0 ? "Fully paid" : paid > 0 ? "Partially paid" : n === 0 ? "No fee" : "Unpaid";
    add(clear(netOut), 
      h("div", { class: "kv" }, h("span", null, L("fee")), h("b", null, money(fee()), fee() !== stdFee() ? h("small", { class: "muted" }, ` (standard ${money(stdFee())})`) : null)),
      disc() ? h("div", { class: "kv" }, h("span", null, form.discType === "waiver" ? "Waiver" : "Discount"), h("b", null, "−" + money(disc()))) : null,
      h("div", { class: "kv total" }, h("span", null, L("netFees")), h("b", null, money(n))),
      hosp() ? null : h("div", { class: "kv" }, h("span", null, L("outstanding")), h("b", null, money(n - paid))),
      h("div", { class: "kv" }, h("span", null, "Status"), h("b", null, status)),
    );
  }

  const save = async (next) => {
    msg.textContent = "";
    if ([feeIn, discIn, amtIn].some((i) => i.paise() === null)) return (msg.textContent = "Check the highlighted amount.");
    const n = fee() - disc();
    const amount = hosp() ? 0 : form.payState === "full" ? n : form.payState === "part" ? amtIn.paise() : 0;
    const input = {
      sessionId: fixed ? fixed.id : undefined,
      date: st.date,
      locationId: st.locationId,
      sessionName: st.sessionName,
      collector: st.collector,
      patientId: pid.value,
      patientName: pname.value,
      category: form.category,
      feePaise: fee(),
      overrideReason: overrideReason.value,
      discountPaise: disc(),
      discountType: form.discType,
      discountReason: discReason.value,
      remarks: remarks.value,
      payment: amount ? { amountPaise: amount, method: form.method, date: payDate.value, reference: refIn.value } : null,
    };
    const res = await attempt(async () => {
      let r = await store.addVisit(input);
      if (r.needsConfirm) {
        if (!(await confirmDialog("Same patient ID in this session", `Patient ID "${input.patientId}" already has a visit in this session. Is this a separate, genuine consultation?`, { ok: "Yes, separate visit" }))) return null;
        r = await store.addVisit(input, { allowDuplicate: true });
      }
      return r;
    });
    if (!res) return;
    root.dataset.dirty = "0";
    await remember(app, st);
    const f = store.ledger.sessionFin.get(res.session.id);
    toast(`Visit saved ✓ (${f.individual.visits} in this session)`);
    if (!next) return app.go("session", { id: res.session.id }, { replace: true });
    pid.value = pname.value = remarks.value = refIn.value = overrideReason.value = discReason.value = "";
    discIn.setPaise(0);
    amtIn.setPaise(0);
    feeIn.setPaise(stdFee());
    add(clear(savedInfo), h("div", { class: "card ok" }, `Saved ${res.visit.id}. `, h("b", null, `${f.individual.visits} visits · ${money(f.individual.net)}`), " recorded in this session. ", h("button", { class: "link", onclick: () => app.go("session", { id: res.session.id }) }, "Open session")));
    recalc();
    root.dataset.dirty = "0";
    pid.focus();
  };

  add(root, 
    h("h1", null, L("individualEntry")),
    fixed
      ? h("div", { class: "card" }, h("b", null, store.locationName(fixed.locationId)), " · ", date(fixed.date), " · ", cap(fixed.sessionName), h("div", { class: "muted small" }, fixed.id))
      : contextPicker(app, st, (what) => {
          if (what === "location" || what === "date") loadRate();
          drawPay();
          recalc();
        }),
    savedInfo,
    h("div", { class: "card" }, h("div", { class: "grid2" }, field("patientId", pid), field("patientName", pname)), h("small", { class: "hint" }, "Optional. No diagnosis, address or medical history is needed.")),
    typeBox,
    h("div", { class: "card" }, h("div", { class: "grid2" }, field("fee", feeIn), field("Discount / waiver ₹", discIn)), overrideBox, discBox),
    payBox,
    netOut,
    field("remarks", remarks),
    msg,
    h("div", { class: "actions sticky" }, h("button", { class: "btn", onclick: () => save(false) }, "Save & close"), h("button", { class: "btn primary big", onclick: () => save(true) }, "Save & next patient")),
  );
  loadRate();
  drawPay();
  recalc();
  root.dataset.dirty = "0";
  return root;
}

export { T };
