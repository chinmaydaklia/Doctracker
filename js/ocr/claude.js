// Cloud handwriting reader using Claude (Anthropic API) through the official SDK.
// Kept separate from the patient database: it receives only the image bytes and
// returns a validated extraction. Nothing from the patient's record is sent.
//
// Privacy: calling this sends the image to Anthropic's API (outside this device).
// The app only calls it after the doctor has enabled cloud reading in settings and
// confirmed the disclosure for the scan. Images are sent inline (base64), not via the
// Files API, so no file is stored on Anthropic's side by this app.

import { EXTRACTION_SCHEMA, validateExtraction } from "./schema.js";

export const MODEL = "claude-opus-5-5";
export const PROVIDER_LABEL = "Claude (Anthropic API, cloud)";

export const SYSTEM_PROMPT = `You transcribe photographed or scanned medical prescriptions from India for a doctor, who will review every field against the image before anything is saved.

Your job is faithful transcription, not interpretation:
- Copy text exactly as written: keep abbreviations (c/o, k/c/o, OD, BD, TDS, HS, SOS, 1-0-1, x 5d, 5/7), brand names, spellings and units as they appear. Do not expand, correct or convert them.
- Hindi or other Indian-language text: copy it in its own script (e.g. Devanagari) as written.
- Never guess. If a word or number cannot be read with confidence, set legibility "unclear" and give your best reading in "text" with the other plausible readings in "alternatives"; if it cannot be read at all, set text null and legibility "illegible". Drug names, strengths, doses, frequencies and durations are safety-critical: be strict.
- Confidence is your honest probability (0-1) that "text" matches what is written.
- Only fill a field from what is on the page. Do not infer a diagnosis from medicines, complaints or tests; do not add medicines, doses or advice that are not written; do not complete partially written words.
- Place each item in the section the writing indicates: c/o → chief_complaints; k/c/o or h/o of a disease → comorbidities (written_as known_case or history_of); O/E, BP, PR, SpO2, Temp, Wt → vitals or examination; "?" before a diagnosis → written_qualifier "query"; Rx and the numbered drug list → medications; Adv → advice; Inv or tests advised → investigations (kind advised; kind result only when a value is written); R/v, review, follow-up → follow_up.
- For each medicine fill name, strength, form (tab/cap/syp/inj…), dose, route, frequency, timing (e.g. before/after food), duration, quantity and instructions only when written; leave the others as text null with legibility "clear" and confidence 1.
- Patient details: copy name, age, sex, ID and mobile only if written on the page.
- Use "conflicts" for contradictions you notice (e.g. two different doses for the same medicine, a date that does not fit). Use "unparsed_text" for writing you could read but could not place.
- Report image_quality honestly; list problems (blur, glare, cut-off edges, faint ink) in quality_issues. If nothing can be read, say so rather than producing content.`;

export const USER_INSTRUCTION = "Transcribe this prescription into the required structure. Remember: copy exactly, flag anything uncertain, never guess.";

export class ReaderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReaderError";
    this.code = code;
  }
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function buildRequest({ bytes, mime }) {
  const source = { type: "base64", media_type: mime, data: b64(bytes) };
  const block = mime === "application/pdf" ? { type: "document", source } : { type: "image", source };
  return {
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [block, { type: "text", text: USER_INSTRUCTION }] }],
  };
}

export async function createClient({ apiKey, baseURL }) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("../../vendor/anthropic-sdk.mjs"));
  } catch {
    throw new ReaderError("The reading component could not be loaded (offline on first use?). Connect to the internet once, or enter the details manually.", "load");
  }
  // A browser client is acceptable here only because the key is the doctor's own, kept
  // encrypted on their device and decrypted only while they are signed in.
  return new Anthropic({ apiKey, baseURL: baseURL || undefined, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 180000 });
}

// Returns { extraction, validationErrors, model, requestId, usage }.
export async function readPrescription({ client, bytes, mime }) {
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) throw new ReaderError("Only JPEG, PNG, WebP or PDF can be read.", "type");
  let res;
  try {
    res = await client.beta.messages.create(buildRequest({ bytes, mime }));
  } catch (e) {
    throw mapError(e);
  }
  if (res.stop_reason === "refusal") throw new ReaderError("The reading service declined this image. Enter the details manually.", "refusal");
  if (res.stop_reason === "max_tokens") throw new ReaderError("The prescription was too long to read in one go. Crop it into parts, or enter it manually.", "truncated");
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReaderError("The reading service returned an unreadable result. Try again or enter manually.", "parse");
  }
  const { extraction, errors } = validateExtraction(raw);
  return { extraction, validationErrors: errors, model: res.model || MODEL, requestId: res._request_id || res.id || null, usage: res.usage || null };
}

function mapError(e) {
  const status = e && e.status;
  const name = e && e.constructor && e.constructor.name;
  if (status === 401 || name === "AuthenticationError") return new ReaderError("The API key was rejected. Check it in More → Clinical note & templates → Prescription reading.", "auth");
  if (status === 403 || name === "PermissionDeniedError") return new ReaderError("This API key is not allowed to use the reading model.", "permission");
  if (status === 429 || name === "RateLimitError") return new ReaderError("The reading service is busy. Wait a minute and try again.", "rate");
  if (status === 413) return new ReaderError("The image is too large. Crop it or use a smaller photo.", "size");
  if (status === 400 || name === "BadRequestError") return new ReaderError("The reading service could not accept this file: " + (e.message || "bad request"), "request");
  if (status >= 500 || name === "InternalServerError") return new ReaderError("The reading service had a problem. Try again shortly.", "server");
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError" || !status) return new ReaderError("Could not reach the reading service (no internet?). You can enter the details manually.", "network");
  return new ReaderError(e.message || "Reading failed.", "unknown");
}
