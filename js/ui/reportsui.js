import { h, add, clear, money, date, field, dateInput, select, segmented, downloadFile } from "./dom.js";
import { today, fyOf, fyRange, fyLabel, monthRange, addMonths, fmtDate } from "../dates.js";
import { dailyReport, monthlyReport, locationReport, paymentReport, settlementReport, reconciliationReport, MONEY } from "../reports.js";
import { reportToCSV } from "../csv.js";
import { SESSION_NAMES } from "../model.js";

const TYPES = [
  { value: "daily", label: "Daily" },
  { value: "monthly", label: "Monthly" },
  { value: "location", label: "Location-wise" },
  { value: "payment", label: "Payments" },
  { value: "settlement", label: "Hospital settlements" },
  { value: "recon", label: "Reconciliation" },
];

let state = null;

export function renderReports(app) {
  const store = app.store;
  const t = today();
  if (!state) state = { type: "daily", ...monthRange(t.slice(0, 7)), locationId: "", payerId: "", sessionName: "" };
  const out = h("div");
  const fromIn = dateInput(state.from, (v) => { state.from = v; draw(); });
  const toIn = dateInput(state.to, (v) => { state.to = v; draw(); });
  const setRange = (r) => { state.from = r.from; state.to = r.to; fromIn.value = r.from; toIn.value = r.to; draw(); };
  const fy = fyOf(t);

  function build() {
    const filter = { from: state.from, to: state.to, locationIds: state.locationId ? [state.locationId] : null, payerId: state.payerId || null, sessionName: state.sessionName || null };
    const L_ = store.ledger;
    const pn = (id) => store.payerName(id);
    switch (state.type) {
      case "monthly":
        return monthlyReport(L_, filter, t);
      case "location":
        return locationReport(L_, filter);
      case "payment":
        return paymentReport(L_, filter, pn);
      case "settlement":
        return settlementReport(store.data, L_, filter, t, pn);
      case "recon":
        return reconciliationReport(L_, filter);
      default:
        return dailyReport(L_, filter);
    }
  }

  function cellText(c, v) {
    if (v === null || v === undefined) return "—";
    if (c.type === MONEY) return money(v);
    if (c.type === "date") return date(v);
    return String(v);
  }

  function draw() {
    clear(out);
    const rep = build();
    const title = TYPES.find((x) => x.value === state.type).label + " report";
    add(out, 
      h("div", { class: "print-head" }, h("h2", null, title), h("p", null, fmtDate(state.from), " to ", fmtDate(state.to), state.locationId ? " · " + store.locationName(state.locationId) : "", state.payerId ? " · " + store.payerName(state.payerId) : "", app.mode === "demo" ? " · DEMO DATA" : "")),
      h("div", { class: "row-btns no-print" }, h("button", { class: "btn", onclick: () => downloadFile(`doctracker-${state.type}-${state.from}-to-${state.to}${app.mode === "demo" ? "-DEMO" : ""}.csv`, reportToCSV(rep), "text/csv;charset=utf-8") }, "⬇ CSV (Excel)"), h("button", { class: "btn", onclick: () => window.print() }, "🖶 Print")),
      rep.rows.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "tbl report" },
              h("thead", null, h("tr", null, rep.columns.map((c) => h("th", { class: c.type === MONEY || c.type === "int" ? "num" : "" }, c.label)))),
              h("tbody", null, rep.rows.map((r) => h("tr", { class: r.sessionId || r.settlementId ? "click" : "", onclick: r.sessionId ? () => app.go("session", { id: r.sessionId }) : r.settlementId ? () => app.go("settlement", { id: r.settlementId }) : null }, rep.columns.map((c) => h("td", { class: c.type === MONEY || c.type === "int" ? "num" : "" }, cellText(c, r[c.key])))))),
              rep.totals ? h("tfoot", null, h("tr", null, rep.columns.map((c, i) => h("td", { class: c.type === MONEY || c.type === "int" ? "num" : "" }, i === 0 ? "Total" : c.key in rep.totals ? cellText(c, rep.totals[c.key]) : "")))) : null,
            ),
          )
        : h("p", { class: "muted" }, "No records for these filters."),
      notes[state.type] ? h("p", { class: "small muted" }, notes[state.type]) : null,
    );
  }

  draw();
  return h(
    "div",
    { class: "screen" },
    h("h1", { class: "no-print" }, "Reports"),
    h(
      "div",
      { class: "card filters no-print" },
      field("Report", select(TYPES, state.type, (v) => { state.type = v; draw(); })),
      h(
        "div",
        { class: "row-btns wrap" },
        h("button", { class: "btn small", onclick: () => setRange({ from: t, to: t }) }, "Today"),
        h("button", { class: "btn small", onclick: () => setRange(monthRange(t.slice(0, 7))) }, "This month"),
        h("button", { class: "btn small", onclick: () => setRange(monthRange(addMonths(t.slice(0, 7), -1))) }, "Last month"),
        h("button", { class: "btn small", onclick: () => setRange(fyRange(fy)) }, fyLabel(fy)),
        h("button", { class: "btn small", onclick: () => setRange(fyRange(fy - 1)) }, fyLabel(fy - 1)),
      ),
      h("div", { class: "grid2" }, field("From", fromIn), field("To", toIn)),
      h(
        "div",
        { class: "grid2" },
        field("location", select([{ value: "", label: "All locations" }, ...store.locationsSorted({ includeInactive: true }).map((l) => ({ value: l.id, label: l.name }))], state.locationId, (v) => { state.locationId = v; draw(); })),
        field("hospital", select([{ value: "", label: "All" }, ...store.data.payers.map((p) => ({ value: p.id, label: p.name }))], state.payerId, (v) => { state.payerId = v; draw(); })),
      ),
      field("session", select([{ value: "", label: "All sessions" }, ...SESSION_NAMES.map((n) => ({ value: n, label: n[0].toUpperCase() + n.slice(1) }))], state.sessionName, (v) => { state.sessionName = v; draw(); })),
    ),
    out,
  );
}

const notes = {
  daily: "Collected = patient money received on that day (summary collections, visit payments, later payments for earlier visits and advances). Outstanding = the session's current unpaid balance. Hospital-collected sessions show fees but no patient collection. ⚠ = session awaiting reconciliation (summary figures counted provisionally).",
  monthly: "Revenue is counted in the month of the consultation; collections in the month the money was received. A payment received in a later month is a collection of that month, never new revenue. Outstanding is the patient receivable at the end of each month (or today for the current month).",
  location: "Average fee = gross fees ÷ patient visits. Collections are by payment date within the range.",
  payment: "Every receipt counted in the books: patient payments, refunds (negative), advances and hospital settlement payments. Summary collections superseded by reconciled individual records are not listed again.",
  settlement: "Provisional periods recalculate from your records until finalised. Salary/minimum amounts are per settlement period.",
  recon: "Sessions recorded as a summary that also have individual entries.",
};

export { segmented };
