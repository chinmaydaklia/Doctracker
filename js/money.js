// Money is always an integer number of paise (₹1 = 100 paise). Never floats.
// Percentages are integer basis points (30% = 3000 bp).

const MAX_PAISE = 1e13; // ₹10,000 crore: far beyond any realistic figure, well inside 2^53

export function isPaise(v) {
  return Number.isInteger(v) && Math.abs(v) <= MAX_PAISE;
}

// Parse a rupee amount typed by the user ("1,250", "300.5", "₹ 40") into paise.
// Returns null when the text is not a valid amount. Negative amounts are rejected
// unless allowNegative is set (only adjustment corrections use it).
export function toPaise(input, { allowNegative = false } = {}) {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    input = String(input);
  }
  let s = String(input).trim().replace(/[₹,\s]/g, "").replace(/^Rs\.?/i, "");
  if (s === "") return null;
  let neg = false;
  if (s[0] === "-" || s[0] === "−") {
    neg = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const paise = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  if (!isPaise(paise)) return null;
  if (neg && !allowNegative) return null;
  return neg ? -paise : paise;
}

function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return parts.join(",") + "," + last3;
}

// ₹1,23,456 (paise shown only when non-zero, or always with {decimals: true}).
export function fmtINR(paise, { decimals = false, sign = false } = {}) {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return "—";
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  let out = "₹" + groupIndian(String(rupees));
  if (decimals || p !== 0) out += "." + String(p).padStart(2, "0");
  if (neg) return "−" + out;
  if (sign && paise > 0) return "+" + out;
  return out;
}

// Plain "1234.50" for CSV cells and input fields (Excel reads it as a number).
export function rupeesStr(paise) {
  if (paise === null || paise === undefined) return "";
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const s = Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  return neg ? "-" + s : s;
}

// Input field value: "300" rather than "300.00" when there are no paise.
export function rupeesInput(paise) {
  if (paise === null || paise === undefined) return "";
  return paise % 100 === 0 ? String(paise / 100) : rupeesStr(paise);
}

// "30", "12.5" -> basis points. Allows 0..100%.
export function pctToBp(input) {
  if (input === null || input === undefined || String(input).trim() === "") return null;
  const s = String(input).trim().replace("%", "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const bp = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return bp <= 10000 ? bp : null;
}

export function bpToPct(bp) {
  if (bp === null || bp === undefined) return "";
  return bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, "");
}

// paise × bp / 10000, rounded half away from zero to the nearest paisa.
export function applyBp(paise, bp) {
  const prod = paise * bp; // < 1e13 * 1e4 = 1e17: exact only below 2^53, so split
  const neg = prod < 0;
  const a = Math.abs(paise);
  // a*bp/10000 = floor(a/10000)*bp + (a%10000)*bp/10000
  const hi = Math.floor(a / 10000) * bp;
  const lo = (a % 10000) * bp; // < 1e8, exact
  const r = hi + Math.floor((lo + 5000) / 10000);
  return neg ? -r : r;
}

export function sum(arr, f = (x) => x) {
  let t = 0;
  for (const x of arr) t += f(x);
  return t;
}
