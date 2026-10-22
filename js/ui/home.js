import { h, money, date, badge } from "./dom.js";
import { L } from "../i18n.js";
import { today, fmtMonth } from "../dates.js";
import { dashboard } from "../insights.js";

function tile(label, value, sub, kind = "", onclick) {
  return h("div", { class: "tile " + kind + (onclick ? " click" : ""), onclick }, h("div", { class: "t-lbl" }, label), h("div", { class: "t-val" }, value), sub ? h("div", { class: "t-sub" }, sub) : null);
}

function bars(rows, valueKey, fmt) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  if (!rows.length) return h("p", { class: "muted" }, "No sessions this month yet.");
  return h("div", { class: "bars" }, rows.map((r) => h("div", { class: "bar-row" }, h("span", { class: "bar-name" }, r.name), h("span", { class: "bar" }, h("i", { style: { width: Math.round((100 * r[valueKey]) / max) + "%" } })), h("b", null, fmt(r[valueKey])))));
}

export function renderHome(app) {
  const t = today();
  const d = dashboard(app.store, t);
  const m = fmtMonth(t.slice(0, 7));
  const quick = h(
    "div",
    { class: "quick" },
    h("button", { class: "btn primary big", onclick: () => app.go("summary") }, "+ ", L("quickSummary")),
    h("button", { class: "btn big", onclick: () => app.go("visit") }, "+ ", L("individualEntry")),
  );

  const recon = d.needsRecon.length
    ? h("div", { class: "card warn click", onclick: () => app.go("sessions", { filter: "recon" }) }, h("b", null, `⚠ ${d.needsRecon.length} session${d.needsRecon.length > 1 ? "s need" : " needs"} reconciliation`), h("div", { class: "muted" }, "Summary and individual records differ or are not yet reviewed. Tap to review."))
    : null;

  const e = d.earnings;
  return h(
    "div",
    { class: "screen" },
    h("h1", null, L("today"), " · ", date(t)),
    quick,
    recon,
    h("h3", { class: "sec" }, "Patients"),
    h(
      "div",
      { class: "tiles" },
      tile(L("today"), String(d.actToday.visits), `${d.actToday.newCount} new · ${d.actToday.followupCount} follow-up`),
      tile(m, String(d.actMonth.visits), `${d.actMonth.newCount} new · ${d.actMonth.followupCount} follow-up${d.actMonth.otherCount ? " · " + d.actMonth.otherCount + " other" : ""}`),
    ),
    h("h3", { class: "sec" }, "Consultation revenue ", h("small", null, "(fees generated, all locations)")),
    h(
      "div",
      { class: "tiles" },
      tile(L("today"), money(d.actToday.net), d.actToday.discount ? `Gross ${money(d.actToday.gross)}` : "net of discounts", "rev"),
      tile(m, money(d.actMonth.net), `Gross ${money(d.actMonth.gross)}`, "rev"),
    ),
    h("h3", { class: "sec" }, "Collections ", h("small", null, "(money actually received)")),
    h(
      "div",
      { class: "tiles" },
      tile("From patients today", money(d.colToday.patient), methodLine(d.colToday), "col"),
      tile("From patients · " + m, money(d.colMonth.patient), methodLine(d.colMonth), "col"),
      tile("From hospitals · " + m, money(d.colMonth.hospital), "settlement payments", "col", () => app.go("money", { tab: "hospitals" })),
      tile("Total received · " + m, money(d.actualReceived), "patients + hospitals", "col"),
    ),
    h("h3", { class: "sec" }, "Receivables ", h("small", null, "(owed to me)")),
    h(
      "div",
      { class: "tiles" },
      tile("Patient balances", money(d.receivable), "unpaid fees, direct-pay locations", "due", () => app.go("money", { tab: "due" })),
      tile("Hospital settlements", money(d.hospitalDue), d.overdue ? `${d.overdue} overdue` : "balance of settlement periods", d.overdue ? "due bad" : "due", () => app.go("money", { tab: "hospitals" })),
    ),
    h("h3", { class: "sec" }, "My earnings · ", m, " ", h("small", null, "(expected, personal)")),
    h(
      "div",
      { class: "card" },
      h("div", { class: "kv" }, h("span", null, "Direct consultations (net fees)"), h("b", null, money(e.direct))),
      e.hospitals.map((x) => h("div", { class: "kv" }, h("span", null, x.name, " ", x.estimate ? badge(x.fromSettlement ? "provisional" : "estimate", "mid") : null, x.needsFigure ? badge("needs hospital figure", "warn") : null), h("b", null, money(x.amount)))),
      h("div", { class: "kv total" }, h("span", null, "Expected earnings"), h("b", null, money(e.total))),
      h("div", { class: "kv" }, h("span", null, "Actually received this month"), h("b", null, money(d.actualReceived))),
      h("p", { class: "muted small" }, "Hospital amounts follow each hospital's agreement (see Money → Hospitals). Revenue, collections, receivables and earnings are different measures and are not added together."),
    ),
    h("h3", { class: "sec" }, "Locations · ", m),
    h("div", { class: "card" }, h("h4", null, "Highest patient volume"), bars(d.topByPatients, "patients", String), h("h4", null, "Highest consultation revenue"), bars(d.topByIncome, "net", (v) => money(v))),
  );
}

function methodLine(c) {
  const parts = [];
  if (c.byMethod.cash) parts.push("Cash " + money(c.byMethod.cash));
  if (c.byMethod.upi) parts.push("UPI " + money(c.byMethod.upi));
  if (c.byMethod.bank) parts.push("Bank " + money(c.byMethod.bank));
  if (c.byMethod.other) parts.push("Other " + money(c.byMethod.other));
  if (c.refunds) parts.push("Refunds −" + money(c.refunds));
  return parts.join(" · ") || "—";
}
