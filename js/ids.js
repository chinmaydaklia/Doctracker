// Stable unique IDs. Random part from crypto (Crockford base32, no ambiguous letters).
// IDs never contain patient names or other personal information.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function rand(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return s;
}

export function newId(prefix) {
  return `${prefix}-${rand(10)}`;
}

function compactDate(iso) {
  return iso.replace(/-/g, "");
}

// Short uppercase code from a location name: "Hospital A — ICU" -> "HAICU"
export function locationCode(name) {
  const words = String(name || "LOC")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const code = words.map((w) => (w.length <= 3 ? w : w[0])).join("");
  return (code || "LOC").slice(0, 6);
}

function sessionCode(name) {
  const s = String(name || "").toLowerCase();
  if (s === "morning") return "MOR";
  if (s === "afternoon") return "AFT";
  if (s === "evening") return "EVE";
  return (s.replace(/[^a-z0-9]/g, "").toUpperCase() || "CUS").slice(0, 4);
}

// e.g. S-20261021-HAICU-MOR-7K2Q9M
export function newSessionId(date, locationName, sessionName) {
  return `S-${compactDate(date)}-${locationCode(locationName)}-${sessionCode(sessionName)}-${rand(6)}`;
}

// e.g. V-20261021-X3T9ZQ7A
export function newVisitId(date) {
  return `V-${compactDate(date)}-${rand(8)}`;
}
