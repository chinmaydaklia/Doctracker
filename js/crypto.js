// Encryption of clinical records at rest (Web Crypto, no third-party code).
//
// - One random 256-bit AES-GCM data key (DEK) encrypts every clinical record and file.
// - The DEK is stored only "wrapped" (encrypted) with a key derived from each
//   clinical user's password (PBKDF2-SHA256), and once more with a recovery code.
// - A user without a wrapped copy (receptionist) cannot decrypt clinical data at all.
// - The same PBKDF2 output also yields a password verifier, so users without clinical
//   access can still sign in.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const DEFAULT_ITERATIONS = 310000;

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// PBKDF2 → 512 bits: first half = verifier (stored), second half = key-encryption key.
export async function deriveFromSecret(secret, saltB64, iterations = DEFAULT_ITERATIONS) {
  const base = await subtle().importKey("raw", enc.encode(secret.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations }, base, 512));
  const kek = await subtle().importKey("raw", bits.slice(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { verifier: toB64(bits.slice(0, 32)), kek };
}

export async function makeCredential(secret, iterations = DEFAULT_ITERATIONS) {
  const salt = toB64(randomBytes(16));
  const { verifier, kek } = await deriveFromSecret(secret, salt, iterations);
  return { salt, iterations, verifier, kek };
}

export async function checkCredential(secret, cred) {
  const { verifier, kek } = await deriveFromSecret(secret, cred.salt, cred.iterations);
  return timingSafeEqual(verifier, cred.verifier) ? kek : null;
}

export async function newDataKey() {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function wrapKey(dek, kek) {
  const raw = await subtle().exportKey("raw", dek);
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, kek, raw);
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function unwrapKey(wrapped, kek) {
  const raw = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(wrapped.iv) }, kek, fromB64(wrapped.ct));
  return subtle().importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
}

export async function sealJSON(dek, obj) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, dek, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function openJSON(dek, sealed) {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv) }, dek, fromB64(sealed.ct));
  return JSON.parse(dec.decode(pt));
}

export async function sealBytes(dek, bytes) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, dek, bytes);
  return { iv: toB64(iv), data: new Uint8Array(ct) };
}

export async function openBytes(dek, iv, data) {
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: fromB64(iv) }, dek, data));
}

export async function sha256Hex(bytes) {
  const h = await subtle().digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Recovery code: 24 base32 characters in groups of 4 (≈120 bits).
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRecoveryCode() {
  const b = randomBytes(24);
  let s = "";
  for (const x of b) s += B32[x & 31];
  return s.match(/.{4}/g).join("-");
}
export function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
