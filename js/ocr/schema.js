// Structured-extraction contract for scanned prescriptions, and conversion of an
// extraction into reviewable fields. Pure: no storage, no network, no DOM.
//
// Every value the reader returns is a "reading": the text exactly as written, how
// legible it was, a confidence, and alternative readings when ambiguous. Unclear text
// is never resolved here; it is flagged for the doctor.

import { matchMedicine } from "./medicines.js";
import { interpretFrequency, interpretDuration } from "./abbreviations.js";

const reading = {
  type: "object",
  properties: {
    text: { type: ["string", "null"], description: "Exactly as written (keep abbreviations, brand names, Hindi in Devanagari). null if absent or illegible." },
    legibility: { type: "string", enum: ["clear", "unclear", "illegible"] },
    confidence: { type: "number", description: "0 to 1: how sure you are the text is what was written." },
    alternatives: { type: "array", items: { type: "string" }, description: "Other plausible readings when ambiguous; empty otherwise." },
  },
  required: ["text", "legibility", "confidence", "alternatives"],
  additionalProperties: false,
};
const obj = (properties, extra = {}) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...extra });
const arr = (items) => ({ type: "array", items });
const en = (...values) => ({ type: "string", enum: values });

export const EXTRACTION_SCHEMA = obj({
  document: obj({
    kind: en("handwritten_prescription", "printed_prescription", "mixed", "lab_report", "discharge_summary", "other_medical", "not_medical"),
    image_quality: en("good", "fair", "poor", "unreadable"),
    quality_issues: arr({ type: "string" }),
    languages: arr({ type: "string" }),
    date: reading,
    prescriber: reading,
    clinic: reading,
  }),
  patient: obj({ name: reading, age: reading, sex: reading, id_number: reading, mobile: reading }),
  chief_complaints: arr(obj({ complaint: reading, duration: reading })),
  comorbidities: arr(obj({ condition: reading, written_as: en("known_case", "history_of", "other") })),
  vitals: arr(obj({ type: en("bp", "pulse", "rr", "temp", "spo2", "weight", "height", "glucose", "other"), label: reading, value: reading, unit: reading })),
  examination: arr(obj({ system: en("general", "cvs", "rs", "abdomen", "cns", "msk", "skin", "other"), finding: reading, written_status: en("normal", "abnormal", "unclear") })),
  diagnoses: arr(obj({ diagnosis: reading, written_qualifier: en("none", "query", "provisional", "rule_out", "differential", "known_case") })),
  investigations: arr(obj({ name: reading, result: reading, unit: reading, kind: en("advised", "result") })),
  medications: arr(obj({ name: reading, strength: reading, form: reading, dose: reading, route: reading, frequency: reading, timing: reading, duration: reading, quantity: reading, instructions: reading })),
  advice: arr(reading),
  follow_up: obj({ interval: reading, date: reading, instructions: reading }),
  unparsed_text: arr({ type: "string" }),
  conflicts: arr({ type: "string" }),
});

// ------------------------------------------------------------- validation

const LEG = ["clear", "unclear", "illegible"];

function cleanReading(r, path, errors) {
  if (!r || typeof r !== "object") {
    errors.push(`${path}: missing`);
    return { text: null, legibility: "illegible", confidence: 0, alternatives: [] };
  }
  const text = r.text === null || r.text === undefined ? null : String(r.text).trim() || null;
  let legibility = LEG.includes(r.legibility) ? r.legibility : (errors.push(`${path}.legibility invalid`), "unclear");
  let confidence = Number(r.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence > 1 && confidence <= 100) confidence /= 100; // tolerate percentages
  confidence = Math.max(0, Math.min(1, confidence));
  const alternatives = Array.isArray(r.alternatives) ? r.alternatives.map((x) => String(x).trim()).filter((x) => x && x !== text).slice(0, 5) : [];
  // text null + "clear" = nothing written there (absent), which is different from
  // "illegible" (something written that cannot be read).
  return { text, legibility, confidence, alternatives };
}

const pickEnum = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

// Validates and normalises the reader's output. Throws only if it is not an object;
// otherwise returns { extraction, errors } with every reading in canonical shape.
export function validateExtraction(raw) {
  if (!raw || typeof raw !== "object") throw new Error("The reader returned no structured result.");
  const errors = [];
  const R = (r, p) => cleanReading(r, p, errors);
  const list = (v) => (Array.isArray(v) ? v : []);
  const d = raw.document || {};
  const p = raw.patient || {};
  const f = raw.follow_up || {};
  const ex = {
    document: {
      kind: pickEnum(d.kind, ["handwritten_prescription", "printed_prescription", "mixed", "lab_report", "discharge_summary", "other_medical", "not_medical"], "other_medical"),
      image_quality: pickEnum(d.image_quality, ["good", "fair", "poor", "unreadable"], "poor"),
      quality_issues: list(d.quality_issues).map(String),
      languages: list(d.languages).map(String),
      date: R(d.date, "document.date"),
      prescriber: R(d.prescriber, "document.prescriber"),
      clinic: R(d.clinic, "document.clinic"),
    },
    patient: { name: R(p.name, "patient.name"), age: R(p.age, "patient.age"), sex: R(p.sex, "patient.sex"), id_number: R(p.id_number, "patient.id_number"), mobile: R(p.mobile, "patient.mobile") },
    chief_complaints: list(raw.chief_complaints).map((c, i) => ({ complaint: R(c.complaint, `complaint ${i + 1}`), duration: R(c.duration, `complaint ${i + 1} duration`) })),
    comorbidities: list(raw.comorbidities).map((c, i) => ({ condition: R(c.condition, `comorbidity ${i + 1}`), written_as: pickEnum(c.written_as, ["known_case", "history_of", "other"], "other") })),
    vitals: list(raw.vitals).map((v, i) => ({ type: pickEnum(v.type, ["bp", "pulse", "rr", "temp", "spo2", "weight", "height", "glucose", "other"], "other"), label: R(v.label, `vital ${i + 1} label`), value: R(v.value, `vital ${i + 1}`), unit: R(v.unit, `vital ${i + 1} unit`) })),
    examination: list(raw.examination).map((x, i) => ({ system: pickEnum(x.system, ["general", "cvs", "rs", "abdomen", "cns", "msk", "skin", "other"], "other"), finding: R(x.finding, `exam ${i + 1}`), written_status: pickEnum(x.written_status, ["normal", "abnormal", "unclear"], "unclear") })),
    diagnoses: list(raw.diagnoses).map((x, i) => ({ diagnosis: R(x.diagnosis, `diagnosis ${i + 1}`), written_qualifier: pickEnum(x.written_qualifier, ["none", "query", "provisional", "rule_out", "differential", "known_case"], "none") })),
    investigations: list(raw.investigations).map((x, i) => ({ name: R(x.name, `investigation ${i + 1}`), result: R(x.result, `investigation ${i + 1} result`), unit: R(x.unit, `investigation ${i + 1} unit`), kind: pickEnum(x.kind, ["advised", "result"], "advised") })),
    medications: list(raw.medications).map((m, i) => Object.fromEntries(MED_KEYS.map((k) => [k, R(m[k], `medicine ${i + 1} ${k}`)]))),
    advice: list(raw.advice).map((a, i) => R(a, `advice ${i + 1}`)),
    follow_up: { interval: R(f.interval, "follow_up.interval"), date: R(f.date, "follow_up.date"), instructions: R(f.instructions, "follow_up.instructions") },
    unparsed_text: list(raw.unparsed_text).map(String),
    conflicts: list(raw.conflicts).map(String),
  };
  return { extraction: ex, errors };
}

export const MED_KEYS = ["name", "strength", "form", "dose", "route", "frequency", "timing", "duration", "quantity", "instructions"];
// Medication parts that must never be guessed: an uncertain one must be typed by the doctor.
export const CRITICAL_MED_KEYS = ["name", "strength", "dose", "frequency", "duration"];

// ---------------------------------------------------------- review fields

const LOW_CONFIDENCE = 0.8;

export function readingFlags(r) {
  const f = [];
  if (r.legibility === "illegible") f.push({ code: "illegible", text: "Illegible — enter it yourself or reject" });
  else if (r.legibility === "unclear") f.push({ code: "unclear", text: "Handwriting unclear" });
  if (r.text !== null && r.confidence < LOW_CONFIDENCE) f.push({ code: "low_confidence", text: `Low confidence (${Math.round(r.confidence * 100)}%)` });
  if (r.alternatives.length) f.push({ code: "ambiguous", text: "Could also read: " + r.alternatives.join(" / ") });
  return f;
}

const UNCERTAIN = new Set(["illegible", "unclear", "low_confidence", "ambiguous", "not_in_catalogue", "similar_name", "partial_name", "conflict", "implausible"]);
export const isUncertain = (field) => field.flags.some((f) => UNCERTAIN.has(f.code));

let seq = 0;
function field(section, group, key, label, r, extra = {}) {
  return {
    id: `${section}.${group}.${key}.${++seq}`,
    section,
    group,
    key,
    label,
    extracted: r ? { ...r } : null, // immutable copy of what was read
    value: r ? r.text : "",
    status: "pending", // pending | approved | edited | rejected | imported
    flags: r ? readingFlags(r) : [],
    hints: [],
    critical: false,
    meta: {},
    history: [],
    ...extra,
  };
}

// Converts an extraction into a flat, ordered list of reviewable fields. Empty readings
// (nothing written) are skipped; illegible ones are kept so the doctor sees the gap.
export function toReviewFields(ex, { catalogue } = {}) {
  seq = 0;
  const out = [];
  const present = (r) => r && (r.text !== null || r.legibility !== "clear");
  const push = (f) => out.push(f);

  for (const k of ["date", "prescriber", "clinic"]) if (present(ex.document[k])) push(field("document", "doc", k, { date: "Prescription date", prescriber: "Prescriber", clinic: "Clinic / hospital" }[k], ex.document[k]));
  for (const k of ["name", "age", "sex", "id_number", "mobile"]) if (present(ex.patient[k])) push(field("patient", "pt", k, { name: "Name", age: "Age", sex: "Sex", id_number: "Patient ID", mobile: "Mobile" }[k], ex.patient[k], { meta: { identityOnly: true } }));

  ex.chief_complaints.forEach((c, i) => {
    if (present(c.complaint)) push(field("complaints", `cc${i}`, "complaint", `Complaint ${i + 1}`, c.complaint));
    if (present(c.duration)) push(field("complaints", `cc${i}`, "duration", `Complaint ${i + 1} — duration`, c.duration));
  });
  ex.comorbidities.forEach((c, i) => present(c.condition) && push(field("comorbidities", `cm${i}`, "condition", `Comorbidity ${i + 1}`, c.condition, { meta: { writtenAs: c.written_as } })));
  ex.vitals.forEach((v, i) => {
    if (!present(v.value)) return;
    const label = v.label.text || v.type.toUpperCase();
    push(field("vitals", `vt${i}`, "value", `${label}`, { ...v.value, text: [v.value.text, v.unit.text].filter(Boolean).join(" ") || null }, { meta: { vitalType: v.type } }));
  });
  ex.examination.forEach((x, i) => present(x.finding) && push(field("examination", `ex${i}`, "finding", `Examination — ${x.system}`, x.finding, { meta: { system: x.system, writtenStatus: x.written_status, status: x.written_status === "unclear" ? null : x.written_status } })));
  ex.diagnoses.forEach((d, i) => {
    if (!present(d.diagnosis)) return;
    const q = d.written_qualifier;
    // Never "confirmed" by default; the doctor must choose it, and only for a clear reading.
    const certainty = q === "query" ? "suspected" : q === "rule_out" ? "suspected" : "provisional";
    const kind = q === "differential" || q === "rule_out" ? "differential" : q === "known_case" ? "comorbidity" : i === 0 ? "primary" : "secondary";
    const f = field("diagnoses", `dx${i}`, "diagnosis", `Diagnosis ${i + 1}`, d.diagnosis, { meta: { qualifier: q, certainty, kind } });
    if (q === "query") f.hints.push("Written with “?” (query)");
    push(f);
  });
  ex.investigations.forEach((x, i) => {
    if (present(x.name)) push(field("investigations", `in${i}`, "name", `Investigation ${i + 1}`, x.name, { meta: { kind: x.kind } }));
    if (present(x.result)) push(field("investigations", `in${i}`, "result", `Investigation ${i + 1} — result`, { ...x.result, text: [x.result.text, x.unit.text].filter(Boolean).join(" ") || null }));
  });
  ex.medications.forEach((m, i) => {
    if (!MED_KEYS.some((k) => present(m[k]))) return;
    for (const k of MED_KEYS) {
      const r = m[k];
      const isCritical = CRITICAL_MED_KEYS.includes(k);
      if (!present(r)) {
        if (["name", "dose", "frequency", "duration"].includes(k)) push(field("medications", `md${i}`, k, `Medicine ${i + 1} — ${k}`, null, { value: "", critical: isCritical, flags: [{ code: "missing", text: "Not written" }] }));
        continue;
      }
      const f = field("medications", `md${i}`, k, `Medicine ${i + 1} — ${k}`, r, { critical: isCritical });
      if (k === "name" && r.text) {
        const mm = matchMedicine(r.text, catalogue);
        f.meta.catalogue = { status: mm.status, match: mm.match ? { name: mm.match.name, generic: mm.match.generic } : null, suggestions: mm.suggestions.map((s) => s.name), note: mm.note || "" };
        if (mm.status === "exact") f.hints.push(`In catalogue: ${mm.match.name} = ${mm.match.generic}`);
        else if (mm.status === "partial") f.flags.push({ code: "partial_name", text: mm.note });
        else if (mm.status === "similar") f.flags.push({ code: "similar_name", text: "Not in catalogue. Similar names: " + mm.suggestions.map((s) => s.name).join(", ") + " — not changed automatically" });
        else f.flags.push({ code: "not_in_catalogue", text: "Not in the medicine catalogue — verify" });
      }
      if (k === "frequency" || k === "timing") {
        const h = interpretFrequency(r.text);
        if (h) f.hints.push("Reads as: " + h.meaning);
      }
      if (k === "duration") {
        const h = interpretDuration(r.text);
        if (h) f.hints.push("Reads as: " + h.meaning);
      }
      push(f);
    }
  });
  ex.advice.forEach((a, i) => present(a) && push(field("advice", `ad${i}`, "advice", `Advice ${i + 1}`, a)));
  for (const k of ["interval", "date", "instructions"]) if (present(ex.follow_up[k])) push(field("followup", "fu", k, { interval: "Follow-up interval", date: "Follow-up date", instructions: "Follow-up instructions" }[k], ex.follow_up[k]));
  return out;
}

// Document-level problems that need attention before anything is trusted.
export function scanFlags(ex) {
  const f = [];
  if (ex.document.kind === "not_medical") f.push({ code: "not_medical", text: "This does not look like a medical document." });
  if (ex.document.image_quality === "unreadable") f.push({ code: "unreadable", text: "Image unreadable — retake a clearer photo or enter the details manually." });
  else if (ex.document.image_quality === "poor") f.push({ code: "poor_quality", text: "Poor image quality: " + (ex.document.quality_issues.join(", ") || "check every field") });
  for (const c of ex.conflicts) f.push({ code: "conflict", text: c });
  if (ex.unparsed_text.length) f.push({ code: "unparsed", text: "Text not placed in any field: " + ex.unparsed_text.join(" | ") });
  return f;
}

// Blank field for manual entry (or for adding an item the reader missed).
export function manualField(section, group, key, label, meta = {}) {
  const rnd = globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return field(section, group, key, label, null, { id: `manual.${section}.${group}.${key}.${rnd}`, status: "pending", meta, flags: [], value: "" });
}
