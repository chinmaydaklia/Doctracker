// Dates are stored as ISO "YYYY-MM-DD" strings in the doctor's local calendar
// (never via toISOString, which would shift dates near midnight IST).
// They are displayed as DD-MM-YYYY.

export function isoLocal(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function today() {
  return isoLocal(new Date());
}

export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

// "21-10-2026" or "21/10/2026" -> "2026-10-21"
export function parseDMY(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!m) return isIsoDate(String(s || "").trim()) ? String(s).trim() : null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return fmtDate(isoLocal(d)) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return isoLocal(new Date(y, m - 1, d + n));
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return MONTHS[m - 1] + " " + y;
}

export function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  return { from: `${ym}-01`, to: isoLocal(new Date(y, m, 0)) };
}

export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

export function monthsBetween(from, to) {
  const out = [];
  let k = monthKey(from);
  const end = monthKey(to);
  while (k <= end) {
    out.push(k);
    k = addMonths(k, 1);
  }
  return out;
}

// Indian financial year: 1 April to 31 March. fyStart(2026) = FY 2026-27.
export function fyOf(iso) {
  const [y, m] = iso.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}
export function fyRange(startYear) {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}
export function fyLabel(startYear) {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function inRange(iso, from, to) {
  return (!from || iso >= from) && (!to || iso <= to);
}

// Settlement period containing `iso` for a frequency.
export function periodFor(frequency, iso) {
  const [y, m, d] = iso.split("-").map(Number);
  if (frequency === "weekly") {
    const dt = new Date(y, m - 1, d);
    const dow = (dt.getDay() + 6) % 7; // Monday start
    const from = isoLocal(new Date(y, m - 1, d - dow));
    return { from, to: addDays(from, 6) };
  }
  if (frequency === "fortnightly") {
    return d <= 15
      ? { from: `${iso.slice(0, 7)}-01`, to: `${iso.slice(0, 7)}-15` }
      : { from: `${iso.slice(0, 7)}-16`, to: monthRange(iso.slice(0, 7)).to };
  }
  if (frequency === "quarterly") {
    const qStartMonth = Math.floor((m - 1) / 3) * 3; // calendar quarters
    return { from: isoLocal(new Date(y, qStartMonth, 1)), to: isoLocal(new Date(y, qStartMonth + 3, 0)) };
  }
  return monthRange(iso.slice(0, 7));
}
