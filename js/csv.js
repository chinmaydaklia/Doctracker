// CSV that opens correctly in Excel: UTF-8 BOM (₹ and Hindi survive), CRLF line ends,
// DD-MM-YYYY dates, amounts as plain numbers in rupees.

import { rupeesStr } from "./money.js";
import { fmtDate } from "./dates.js";

function cell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Text that Excel would run as a formula is neutralised.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function reportToCSV(report) {
  const lines = [report.columns.map((c) => cell(c.label + (c.type === "money" ? " (₹)" : ""))).join(",")];
  const fmt = (c, v) => (c.type === "money" ? (v === null || v === undefined ? "" : rupeesStr(v)) : c.type === "date" ? fmtDate(v) : v);
  for (const r of report.rows) lines.push(report.columns.map((c) => cell(fmt(c, r[c.key]))).join(","));
  if (report.totals) {
    lines.push(report.columns.map((c, i) => (i === 0 ? "Total" : c.key in report.totals ? cell(fmt(c, report.totals[c.key])) : "")).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let f = "";
  let q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}
