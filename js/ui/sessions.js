// Sessions list, session detail with reconciliation, and per-visit actions.
import { h, add, clear, money, date, field, moneyInput, dateInput, segmented, select, toast, modal, confirmDialog, askReason, attempt, badge } from "./dom.js";
import { L } from "../i18n.js";
import { today, addDays, fmtDateTime } from "../dates.js";
import { METHODS, SESSION_MODES } from "../model.js";
import { rateFor } from "../calc.js";
import { sessionRow, cap } from "./entry.js";

export function renderSessions(app, params) {
  const store = app.store;
  const f = { from: params.from || addDays(today(), -6), to: params.to || today(), locationId: params.locationId || "", onlyRecon: params.filter === "recon" };
  const list = h("div");
  const draw = () => {
    clear(list);
    const ss = store.data.sessions
      .filter((s) => !s.voided && (f.onlyRecon || (s.date >= f.from && s.date <= f.to)) && (!f.locationId || s.locationId === f.locationId))
      .filter((s) => !f.onlyRecon || store.ledger.sessionFin.get(s.id)?.needsRecon)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    if (!ss.length) add(list, h("p", { class: "muted" }, f.onlyRecon ? "Nothing to reconcile. ✓" : "No sessions in this period."));
    let lastDate = null;
    for (const s of ss) {
      if (s.date !== lastDate) {
        lastDate = s.date;
        const dayTotal = ss.filter((x) => x.date === s.date).reduce((t, x) => t + store.ledger.sessionFin.get(x.id).eff.visits, 0);
        add(list, h("h3", { class: "sec" }, date(s.date), h("small", null, ` · ${dayTotal} patients`)));
      }
      add(list, sessionRow(app, s));
    }
  };
  const fromIn = dateInput(f.from, (v) => { f.from = v; draw(); });
  const toIn = dateInput(f.to, (v) => { f.to = v; draw(); });
  draw();
  return h(
    "div",
    { class: "screen" },
    h("h1", null, L("sessions")),
    h(
      "div",
      { class: "card filters" },
      h("div", { class: "grid2" }, field("From", fromIn), field("To", toIn)),
      field("location", select([{ value: "", label: "All locations" }, ...store.locationsSorted({ includeInactive: true }).map((l) => ({ value: l.id, label: l.name }))], f.locationId, (v) => { f.locationId = v; draw(); })),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.onlyRecon, onchange: (e) => { f.onlyRecon = e.target.checked; draw(); } }), " Only sessions needing reconciliation"),
    ),
    list,
  );
}

const ITEM_LABEL = { newCount: "New patients", followupCount: "Follow-ups", visits: "Total patient visits", gross: "Gross fees", discount: "Discounts & waivers", net: "Net fees", paid: "Payments received (session day)", outstanding: "Outstanding" };
const isMoney = (k) => !["newCount", "followupCount", "visits"].includes(k);

export function renderSession(app, { id }) {
  const store = app.store;
  const s = store.get("sessions", id);
  if (!s) return h("div", { class: "screen" }, h("p", null, "Session not found."), h("button", { class: "btn", onclick: () => app.go("sessions") }, "Back"));
  const L_ = store.ledger;
  const f = L_.sessionFin.get(id);
  const visits = store.data.visits.filter((v) => v.sessionId === id && !v.voided).sort((a, b) => a.createdAt - b.createdAt);
  const rerender = () => app.go("session", { id }, { replace: true });
  if (s.voided) return h("div", { class: "screen" }, h("h1", null, "Voided session"), h("p", null, s.voidReason), h("p", { class: "muted small" }, s.id));

  const e = f.eff;
  const head = h(
    "div",
    { class: "card" },
    h("h1", null, store.locationName(s.locationId)),
    h("div", null, date(s.date), " · ", cap(s.sessionName), " · ", SESSION_MODES[s.mode]),
    h("div", { class: "muted small" }, s.id, " · ", s.collector === "hospital" ? "Hospital collects fees" : "Patients pay me directly"),
    h("div", { class: "badges" }, f.needsRecon ? badge("Needs reconciliation", "warn") : null, s.status === "reconciled" ? badge("Reconciled", "ok") : null, badge(f.source === "summary" ? (f.needsRecon ? "Counting summary (provisional)" : "Counting summary") : "Counting individual records", "mid")),
    s.remarks ? h("p", { class: "small" }, s.remarks) : null,
  );

  const totals = h(
    "div",
    { class: "card totals" },
    h("div", { class: "kv" }, h("span", null, L("patients")), h("b", null, `${e.visits} (${e.newCount} new · ${e.followupCount} follow-up${e.otherCount ? " · " + e.otherCount + " other" : ""})`)),
    h("div", { class: "kv" }, h("span", null, L("grossFees")), h("b", null, money(e.gross))),
    h("div", { class: "kv" }, h("span", null, L("discounts")), h("b", null, "−" + money(e.discount - e.correction))),
    h("div", { class: "kv total" }, h("span", null, L("netFees")), h("b", null, money(e.net))),
    s.collector === "hospital" ? null : [h("div", { class: "kv" }, h("span", null, L("collected")), h("b", null, money(e.paid))), h("div", { class: "kv" + (e.outstanding > 0 ? " due" : "") }, h("span", null, L("outstanding")), h("b", null, money(e.outstanding)))],
  );

  const actions = h(
    "div",
    { class: "row-btns wrap" },
    h("button", { class: "btn primary", onclick: () => app.go("visit", { sessionId: id }) }, "+ Add patient"),
    s.summary ? h("button", { class: "btn", onclick: () => app.go("summary", { id }) }, "Edit summary") : null,
    s.collector === "me" && f.source === "summary" && e.outstanding > 0 ? h("button", { class: "btn", onclick: () => payDialog(app, "session", id, e.outstanding).then((ok) => ok && rerender()) }, "Record later payment") : null,
    s.summary && f.source === "summary" ? h("button", { class: "btn", onclick: () => adjustDialog(app, "session", id).then((ok) => ok && rerender()) }, "Discount / correction") : null,
    h("button", { class: "btn", onclick: () => remarkDialog(app, s).then((ok) => ok && rerender()) }, "Remarks"),
    h("button", { class: "btn danger-o", onclick: async () => {
      const r = await askReason("Void this session?", "Use this only for a session entered by mistake. The record is kept, marked void.", { ok: "Void session", danger: true });
      if (r === null) return;
      if (await attempt(() => store.voidSession(id, r).then(() => true))) { toast("Session voided"); app.back(); }
    } }, "Void"),
  );

  return h("div", { class: "screen" }, head, totals, actions, reconPanel(app, s, f, rerender), visitsPanel(app, s, visits, rerender), paymentsPanel(app, s, rerender));
}

function reconPanel(app, s, f, rerender) {
  if (!f.recon) return null;
  const store = app.store;
  const rows = f.recon.items.map((i) =>
    h("tr", { class: i.diff ? "diff" : "" }, h("td", null, ITEM_LABEL[i.key]), h("td", null, isMoney(i.key) ? money(i.summary) : i.summary), h("td", null, isMoney(i.key) ? money(i.individual) : i.individual), h("td", null, i.diff === 0 ? "✓" : (i.diff > 0 ? "+" : "") + (isMoney(i.key) ? money(i.diff) : i.diff))),
  );
  const box = h(
    "div",
    { class: "card " + (f.needsRecon ? "warn" : "") },
    h("h3", null, "Reconciliation"),
    h("p", { class: "small muted" }, "Summary figures vs the individual records entered for this session. Only one of them is counted — never both."),
    h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Summary"), h("th", null, "Individual"), h("th", null, "Difference"))), h("tbody", null, rows))),
  );
  if (s.status === "reconciled") {
    add(box, 
      h("p", null, "Reconciled by ", s.recon.by, " on ", fmtDateTime(s.recon.at), ". Counting: ", h("b", null, s.recon.source === "summary" ? "summary figures" : "individual records"), s.recon.note ? h("span", null, " — ", s.recon.note) : null),
      h("button", { class: "btn", onclick: async () => {
        const r = await askReason("Reopen reconciliation", "Why are you reopening this session?");
        if (r === null) return;
        if (await attempt(() => store.reopenSession(s.id, r).then(() => true))) rerender();
      } }, "Reopen"),
    );
  } else {
    const note = h("textarea", { rows: 2, placeholder: f.recon.matches ? "Note (optional)" : "Reason for the difference (required)" });
    add(box, 
      h("p", null, f.recon.matches ? h("b", { class: "okc" }, "Summary and individual records match.") : h("b", { class: "badc" }, "The records differ. Review the differences above.")),
      note,
      h(
        "div",
        { class: "row-btns wrap" },
        f.visitCount ? h("button", { class: "btn primary", onclick: async () => {
          if (await attempt(() => store.reconcileSession(s.id, { source: "individual", note: note.value }).then(() => true))) { toast("Reconciled ✓ — individual records are the source of truth"); rerender(); }
        } }, "Individual records are correct") : null,
        f.recon.matches ? null : h("button", { class: "btn", onclick: async () => {
          if (await attempt(() => store.reconcileSession(s.id, { source: "summary", note: note.value }).then(() => true))) { toast("Reconciled ✓ — summary figures kept"); rerender(); }
        } }, "Keep summary figures"),
        f.visitCount === 0 ? h("button", { class: "btn", onclick: async () => {
          if (await attempt(() => store.updateSessionInfo(s.id, { mode: "summary" }, "Keep as summary only").then(() => true))) rerender();
        } }, "Keep as summary only") : null,
      ),
    );
  }
  return box;
}

const STATUS = { paid: ["Paid", "ok"], partial: ["Part paid", "warn"], unpaid: ["Unpaid", "bad"], waived: ["Waived", "mid"], free: ["No fee", "mid"], cancelled: ["Cancelled", "mid"], refund_due: ["Cancelled · refund due", "bad"] };

function visitsPanel(app, s, visits, rerender) {
  const store = app.store;
  if (!visits.length) return h("div", { class: "card" }, h("h3", null, "Individual visits"), h("p", { class: "muted" }, s.mode === "summary" ? "Summary only. Add patients to reconcile individual records with this summary." : "No visits yet."));
  return h(
    "div",
    { class: "card" },
    h("h3", null, `Individual visits (${visits.filter((v) => !v.cancelled).length})`),
    visits.map((v, i) => {
      const vf = store.ledger.visitFin.get(v.id);
      const [st, kind] = STATUS[vf.status] || [vf.status, ""];
      return h(
        "button",
        { class: "row click" + (v.cancelled ? " struck" : ""), onclick: () => visitDialog(app, v, s).then((ok) => ok && rerender()) },
        h("div", null, h("b", null, `${i + 1}. ${v.categoryLabel}`), h("div", { class: "muted small" }, [v.patientId, v.patientName].filter(Boolean).join(" · ") || "—", v.overrideReason ? " · fee changed" : "")),
        h("div", { class: "right" }, h("b", null, money(vf.net)), h("div", null, s.collector === "hospital" ? badge("Hospital", "mid") : badge(st + (vf.outstanding > 0 && vf.status !== "unpaid" ? " · " + money(vf.outstanding) + " due" : ""), kind))),
      );
    }),
  );
}

function paymentsPanel(app, s, rerender) {
  const store = app.store;
  const L_ = store.ledger;
  const visitIds = new Set(store.data.visits.filter((v) => v.sessionId === s.id).map((v) => v.id));
  const pays = store.data.payments.filter((p) => !p.voided && (p.sessionId === s.id || (L_.allocByPayment.get(p.id) || []).some((a) => visitIds.has(a.targetId)))).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!pays.length) return null;
  const counted = new Set(L_.entries.filter((e) => e.sessionId === s.id).map((e) => e.paymentId));
  return h(
    "div",
    { class: "card" },
    h("h3", null, "Payments"),
    pays.map((p) =>
      h(
        "div",
        { class: "row" + (counted.has(p.id) ? "" : " dim") },
        h("div", null, h("b", null, (p.kind === "refund" ? "Refund · " : "") + METHODS[p.method]), h("div", { class: "muted small" }, date(p.date), p.reference ? " · " + p.reference : "", p.origin === "summary" ? " · summary collection" : "", counted.has(p.id) ? "" : " · not counted (other source in use)")),
        h("div", { class: "right" }, h("b", null, (p.kind === "refund" ? "−" : "") + money(p.amountPaise)), p.origin !== "summary" ? h("button", { class: "link small", onclick: async () => {
          const r = await askReason("Void payment?", "Use this to reverse a payment entered by mistake. The record is kept, marked void.", { ok: "Void", danger: true });
          if (r === null) return;
          if (await attempt(() => store.voidPayment(p.id, r).then(() => true))) rerender();
        } }, "Void") : null),
      ),
    ),
  );
}

// ------------------------------------------------------------------ dialogs

export function payDialog(app, targetType, targetId, outstanding) {
  const store = app.store;
  const target = targetType === "visit" ? store.get("visits", targetId) : store.get("sessions", targetId);
  const amt = moneyInput({ value: outstanding });
  let method = "cash";
  const d = dateInput(today());
  const ref = h("input", { type: "text", placeholder: "Reference (optional)" });
  const err = h("div", { class: "err" });
  return modal("Record payment", [h("p", null, "Outstanding: ", h("b", null, money(outstanding)), " · consultation ", date(target.date)), field("amountReceived", amt), field("paymentMethod", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), method, (v) => (method = v))), field("Payment date", d), field("reference", ref), err], [
    { label: "Cancel", result: false },
    {
      label: "Save payment",
      kind: "primary",
      value: () => {
        const a = amt.paise();
        return store
          .recordPatientPayment({ date: d.value, method, amountPaise: a, reference: ref.value, allocations: [{ targetType, targetId, amountPaise: a }] })
          .then(() => { toast("Payment saved ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; });
      },
    },
  ]);
}

function refundDialog(app, targetType, targetId, paid) {
  const store = app.store;
  const amt = moneyInput({ value: paid });
  let method = "cash";
  const d = dateInput(today());
  const reason = h("input", { type: "text", placeholder: "Reason (required)" });
  const err = h("div", { class: "err" });
  return modal("Record refund", [h("p", null, "Received so far: ", h("b", null, money(paid))), field("Refund amount", amt), field("Refunded by", segmented(Object.entries(METHODS).map(([value, label]) => ({ value, label })), method, (v) => (method = v))), field("Refund date", d), field("reason", reason), err], [
    { label: "Cancel", result: false },
    {
      label: "Save refund",
      kind: "danger",
      value: () => {
        return store
          .recordRefund({ date: d.value, method, amountPaise: amt.paise(), targetType, targetId, reason: reason.value })
          .then(() => { toast("Refund recorded"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; });
      },
    },
  ]);
}

export function adjustDialog(app, targetType, targetId) {
  const store = app.store;
  let type = "discount";
  const amt = moneyInput({ allowNegative: true });
  const reason = h("input", { type: "text", placeholder: "Reason (required)" });
  const err = h("div", { class: "err" });
  const hint = h("small", { class: "hint" }, "Discount and waiver reduce the fee. A correction can be + or − (e.g. −50 or 100).");
  return modal("Add adjustment", [field("Type", segmented([{ value: "discount", label: "Discount" }, { value: "waiver", label: "Waiver" }, { value: "correction", label: "Correction ±" }], type, (v) => (type = v))), field("Amount ₹", amt), hint, field("reason", reason), err], [
    { label: "Cancel", result: false },
    {
      label: "Save",
      kind: "primary",
      value: () => {
        return store
          .addAdjustment({ targetType, targetId, type, amountPaise: amt.paise(), reason: reason.value })
          .then(() => { toast("Adjustment saved ✓"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; });
      },
    },
  ]);
}

function remarkDialog(app, s) {
  const ta = h("textarea", { rows: 3, value: s.remarks || "" });
  return modal("Session remarks", ta, [
    { label: "Cancel", result: false },
    { label: "Save", kind: "primary", value: () => attempt(() => app.store.updateSessionInfo(s.id, { remarks: ta.value })).then((r) => (r ? true : undefined)) },
  ]);
}

function correctDialog(app, v, s) {
  const store = app.store;
  const rate = rateFor(store.data.rates, s.locationId, s.date);
  let category = v.category;
  const pid = h("input", { type: "text", value: v.patientId });
  const pname = h("input", { type: "text", value: v.patientName });
  const fee = moneyInput({ value: v.feePaise });
  const rem = h("input", { type: "text", value: v.remarks });
  const reason = h("input", { type: "text", placeholder: "Reason for correction (required)" });
  const err = h("div", { class: "err" });
  const cats = rate ? rate.categories : [{ key: v.category, label: v.categoryLabel }];
  return modal("Correct visit", [field("visitType", segmented(cats.map((c) => ({ value: c.key, label: c.label })), category, (k) => { category = k; const c = cats.find((x) => x.key === k); if (c && c.feePaise !== undefined) fee.setPaise(c.feePaise); })), field("fee", fee), field("patientId", pid), field("patientName", pname), field("remarks", rem), field("reason", reason), err], [
    { label: "Cancel", result: false },
    {
      label: "Save correction",
      kind: "primary",
      value: () => {
        return store
          .updateVisit(v.id, { category, feePaise: fee.paise(), patientId: pid.value, patientName: pname.value, remarks: rem.value, overrideReason: reason.value }, reason.value)
          .then(() => { toast("Corrected ✓ (logged)"); app.render(); return true; })
          .catch((e) => { err.textContent = e.message; return undefined; });
      },
    },
  ]);
}

function visitDialog(app, v, s) {
  const store = app.store;
  const vf = store.ledger.visitFin.get(v.id);
  const adjs = (store.ledger.adjByTarget.get("visit:" + v.id) || []).filter((a) => !a.voided);
  const direct = s.collector === "me";
  const go = (fn) => () => { document.querySelector(".modal-back")?.remove(); fn(); };
  const info = [
    h("p", { class: "muted small" }, v.id),
    h("div", { class: "kv" }, h("span", null, "Type"), h("b", null, v.categoryLabel)),
    v.patientId || v.patientName ? h("div", { class: "kv" }, h("span", null, "Patient"), h("b", null, [v.patientId, v.patientName].filter(Boolean).join(" · "))) : null,
    clinicalLinks(app, v, go),
    h("div", { class: "kv" }, h("span", null, "Fee"), h("b", null, money(v.feePaise), v.feePaise !== v.standardFeePaise ? h("small", null, ` (standard ${money(v.standardFeePaise)}: ${v.overrideReason})`) : null)),
    adjs.map((a) => h("div", { class: "kv" }, h("span", null, a.type[0].toUpperCase() + a.type.slice(1), ": ", a.reason), h("b", null, a.type === "correction" ? money(a.amountPaise, { sign: true }) : a.type === "cancellation" ? "" : "−" + money(a.amountPaise)))),
    h("div", { class: "kv total" }, h("span", null, "Net fee"), h("b", null, money(vf.net))),
    direct ? h("div", { class: "kv" }, h("span", null, "Received"), h("b", null, money(vf.paid))) : null,
    direct ? h("div", { class: "kv" }, h("span", null, "Outstanding"), h("b", null, money(vf.outstanding))) : null,
    v.remarks ? h("p", { class: "small" }, v.remarks) : null,
    v.cancelled
      ? h("p", { class: "badc" }, "Cancelled — not counted as a consultation.")
      : h(
          "div",
          { class: "row-btns wrap" },
          direct && vf.outstanding > 0 ? h("button", { class: "btn primary", onclick: go(() => payDialog(app, "visit", v.id, vf.outstanding)) }, "Record payment") : null,
          h("button", { class: "btn", onclick: go(() => adjustDialog(app, "visit", v.id)) }, "Discount / waiver"),
          h("button", { class: "btn", onclick: go(() => correctDialog(app, v, s)) }, "Correct"),
          direct && vf.paid > 0 ? h("button", { class: "btn", onclick: go(() => refundDialog(app, "visit", v.id, vf.paid)) }, "Refund") : null,
          h("button", { class: "btn danger-o", onclick: go(async () => {
            const r = await askReason("Cancel visit", "The visit will no longer count as a consultation. Any payment stays recorded until refunded.", { ok: "Cancel visit", danger: true });
            if (r === null) return;
            if (await attempt(() => store.cancelVisit(v.id, r).then(() => true))) app.render();
          }) }, "Cancel visit"),
          vf.paid === 0 ? h("button", { class: "btn danger-o", onclick: go(async () => {
            const r = await askReason("Void visit", "Only for a visit entered by mistake (e.g. typed twice). The record is kept, marked void.", { ok: "Void", danger: true });
            if (r === null) return;
            if (await attempt(() => store.voidVisit(v.id, r).then(() => true))) app.render();
          }) }, "Void (entered by mistake)") : null,
        ),
    adjs.filter((a) => a.type !== "cancellation").length && !v.cancelled
      ? h("div", { class: "small" }, "Adjustments: ", adjs.filter((a) => a.type !== "cancellation").map((a) => h("button", { class: "link small", onclick: go(async () => {
          const r = await askReason("Void adjustment", `${a.type} of ${money(a.amountPaise)} — ${a.reason}`, { ok: "Void", danger: true });
          if (r === null) return;
          if (await attempt(() => store.voidAdjustment(a.id, r).then(() => true))) app.render();
        }) }, "void " + a.type + " " + money(a.amountPaise))))
      : null,
  ];
  return modal("Visit", info, [{ label: "Close", result: false }]);
}

export { confirmDialog, select };

// Patient record and clinical record for a financial visit. Linking changes no money.
function clinicalLinks(app, v, go) {
  const store = app.store;
  if (!store.perms.includes("patients")) return null;
  const p = v.patientRecordId && store.get("patients", v.patientRecordId);
  const enc = store.encounterForVisit(v.id);
  return h(
    "div",
    { class: "card soft" },
    p ? h("div", { class: "kv" }, h("span", null, "Patient record"), h("button", { class: "link", onclick: go(() => app.go("patient", { id: p.id })) }, p.name, " · ", p.id)) : h("p", { class: "small muted" }, "Not linked to a registered patient."),
    enc ? h("div", { class: "kv" }, h("span", null, "Clinical record"), store.can("clinical.read") ? h("button", { class: "link", onclick: go(() => app.go("encounter", { id: enc.id })) }, enc.status === "finalized" ? "signed ✓ open" : "draft — open") : h("b", null, enc.status === "finalized" ? "signed" : "in progress")) : null,
    h(
      "div",
      { class: "row-btns wrap" },
      !p && !v.voided ? h("button", { class: "btn small", onclick: go(() => linkPatientDialog(app, v)) }, "Link to patient") : null,
      !enc && store.can("clinical.write") && !v.cancelled ? h("button", { class: "btn small primary", onclick: go(() => app.go("newEncounter", { visitId: v.id, patientId: v.patientRecordId })) }, "Write clinical note") : null,
    ),
  );
}

async function linkPatientDialog(app, v) {
  const store = app.store;
  const { searchPatients, ageLabel } = await import("../clinical.js");
  const q = h("input", { type: "search", placeholder: "Search name, mobile, patient ID", value: v.patientName || v.patientId || "" });
  const res = h("div");
  const run = () => {
    while (res.firstChild) res.removeChild(res.firstChild);
    for (const x of searchPatients(store.data.patients, q.value).slice(0, 8)) {
      res.append(h("button", { class: "row click", onclick: async () => { if (await attempt(() => store.linkVisitToPatient(v.id, x.id).then(() => true))) { document.querySelector(".modal-back")?.remove(); toast("Linked ✓ (no change to fees)"); app.render(); } } }, h("div", null, h("b", null, x.name), h("div", { class: "small muted" }, ageLabel(x), " · ", x.id))));
    }
  };
  q.addEventListener("input", run);
  run();
  return modal("Link visit to patient", [q, res, h("button", { class: "btn small", onclick: () => { document.querySelector(".modal-back")?.remove(); app.go("patientForm", { name: v.patientName || "" }); } }, "+ Register new patient")], [{ label: "Close", result: false }]);
}
