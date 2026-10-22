// Pure clinical helpers: no storage, no DOM. Nothing here turns a finding into a
// diagnosis or a diagnosis into a prescription; it only checks, computes and formats.

import { fmtDate, addDays } from "./dates.js";
import { EXAM_STATUS, CERTAINTY, DIAGNOSIS_KINDS, GLUCOSE_CONTEXT, GLUCOSE_SOURCE, ENCOUNTER_TYPES } from "./model.js";

// ------------------------------------------------------------------ patients

export function ageOf(patient, onDate) {
  if (!patient) return null;
  const on = onDate ? new Date(onDate + "T00:00:00") : new Date();
  if (patient.dob) {
    const b = new Date(patient.dob + "T00:00:00");
    let months = (on.getFullYear() - b.getFullYear()) * 12 + (on.getMonth() - b.getMonth());
    if (on.getDate() < b.getDate()) months--;
    return { years: Math.floor(months / 12), months, exact: true };
  }
  if (Number.isFinite(patient.ageYears)) {
    const rec = patient.ageRecordedOn ? new Date(patient.ageRecordedOn + "T00:00:00") : on;
    const extra = Math.max(0, Math.floor((on - rec) / (365.25 * 864e5)));
    return { years: patient.ageYears + extra, months: (patient.ageYears + extra) * 12, exact: false };
  }
  return null;
}

export function ageLabel(patient, onDate) {
  const a = ageOf(patient, onDate);
  if (!a) return "age ?";
  if (a.years < 2) return `${a.months} mo`;
  return `${a.years} y${a.exact ? "" : " (approx.)"}`;
}

const TITLES = /^(mr|mrs|ms|miss|dr|shri|smt|kumari|km|master|baby|b\/o)\.?\s+/i;
export function normalizeName(name) {
  return String(name || "").toLowerCase().replace(TITLES, "").replace(/[^a-zऀ-ॿ ]/g, " ").replace(/\s+/g, " ").trim();
}
export function mobileDigits(m) {
  const d = String(m || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function namesSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(" "), tb = b.split(" ");
  const setB = new Set(tb);
  if (ta.length > 1 && ta.every((t) => setB.has(t))) return true; // reordered
  return lev(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 6));
}

// Possible existing profiles for a registration. Never merges: the caller asks the user.
export function findPatientMatches(patients, input, today) {
  const name = normalizeName(input.name);
  const mob = mobileDigits(input.mobile);
  const age = ageOf(input, today);
  const out = [];
  for (const p of patients) {
    if (p.id === input.id || p.active === false) continue;
    const reasons = [];
    let score = 0;
    const pm = mobileDigits(p.mobile);
    if (mob.length === 10 && pm === mob) {
      reasons.push("same mobile number");
      score += 3;
    }
    const pn = normalizeName(p.name);
    if (namesSimilar(name, pn)) {
      reasons.push(name === pn ? "same name" : "similar name");
      score += name === pn ? 2 : 1;
      if (input.dob && p.dob && input.dob === p.dob) {
        reasons.push("same date of birth");
        score += 2;
      } else {
        const pa = ageOf(p, today);
        if (age && pa && Math.abs(age.years - pa.years) <= 2) {
          reasons.push("similar age");
          score += 1;
        }
      }
    }
    if (score >= 2) out.push({ patient: p, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function searchPatients(patients, q, visitsByPatient) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return patients;
  const digits = s.replace(/\D/g, "");
  const n = normalizeName(s);
  return patients.filter((p) => {
    if (p.id.toLowerCase().includes(s)) return true;
    if (digits.length >= 4 && mobileDigits(p.mobile).includes(digits)) return true;
    if (n && normalizeName(p.name).includes(n)) return true;
    if ((p.externalIds || []).some((x) => String(x.value).toLowerCase() === s)) return true;
    if (visitsByPatient && (visitsByPatient.get(p.id) || []).some((v) => v.patientId && v.patientId.toLowerCase() === s)) return true;
    return false;
  });
}

// -------------------------------------------------------------------- vitals

export const VITAL_DEFS = {
  bp: { label: "Blood pressure", unit: "mmHg" },
  pulse: { label: "Pulse", unit: "/min", impossible: [20, 250], adult: [60, 100] },
  rr: { label: "Respiratory rate", unit: "/min", impossible: [4, 80], adult: [12, 20] },
  temp: { label: "Temperature", unit: "°C", impossible: [25, 45], adult: [36.0, 37.5] },
  spo2: { label: "SpO₂", unit: "%", impossible: [30, 100], adult: [95, 100] },
  height: { label: "Height", unit: "cm", impossible: [30, 250] },
  weight: { label: "Weight", unit: "kg", impossible: [0.5, 350] },
  glucose: { label: "Blood glucose", unit: "mg/dL", impossible: [10, 1500] },
  pain: { label: "Pain score", unit: "/10", impossible: [0, 10] },
  other: { label: "Other", unit: "" },
};

// Returns { errors, flags }. Errors = physically implausible (must be corrected or
// explicitly confirmed). Flags = outside reference / suspicious (saved, marked for review).
// Values are never changed here.
export function checkVital(m, ageYears) {
  const errors = [];
  const flags = [];
  const d = VITAL_DEFS[m.type];
  if (!d) return { errors: ["Unknown measurement type."], flags };
  const child = Number.isFinite(ageYears) && ageYears < 18;
  const adultNote = child ? null : Number.isFinite(ageYears) ? "adult reference" : "adult reference; age not recorded";
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (m.type === "bp") {
    const { systolic: s, diastolic: di } = m.values || {};
    if (!num(s) || !num(di)) errors.push("Enter both systolic and diastolic.");
    else {
      if (s < 40 || s > 300) errors.push(`Systolic ${s} mmHg is outside the possible range (40–300).`);
      if (di < 20 || di > 200) errors.push(`Diastolic ${di} mmHg is outside the possible range (20–200).`);
      if (s <= di) errors.push("Systolic must be higher than diastolic.");
      if (s - di < 15 && s > di) flags.push("Narrow pulse pressure — recheck");
      if (!child && !errors.length) {
        if (s >= 180 || di >= 120) flags.push(`Very high BP (${adultNote})`);
        else if (s >= 140 || di >= 90) flags.push(`Above ${adultNote} (<140/90)`);
        else if (s < 90 || di < 60) flags.push(`Below ${adultNote} (≥90/60)`);
      }
    }
    return { errors, flags, child };
  }
  if (m.type === "other") {
    if (!String(m.name || "").trim()) errors.push("Name the observation.");
    if (m.value === null || m.value === undefined || m.value === "") errors.push("Enter a value.");
    return { errors, flags, child };
  }
  const v = m.value;
  if (!num(v)) return { errors: ["Enter a number."], flags, child };
  if (m.type === "temp" && v >= 90 && v <= 110) errors.push(`${v} looks like °F. Enter temperature in °C (${(((v - 32) * 5) / 9).toFixed(1)} °C).`);
  else if (m.type === "height" && v > 0 && v < 3) errors.push(`${v} looks like metres. Enter height in cm.`);
  else if (d.impossible && (v < d.impossible[0] || v > d.impossible[1])) errors.push(`${d.label} ${v} ${d.unit} is outside the possible range (${d.impossible[0]}–${d.impossible[1]}).`);
  if (m.type === "pain" && !Number.isInteger(v)) errors.push("Pain score is a whole number 0–10.");
  if (errors.length) return { errors, flags, child };
  if (d.adult && !child) {
    if (v < d.adult[0]) flags.push(`Below ${adultNote} (${d.adult[0]}–${d.adult[1]} ${d.unit})`);
    else if (v > d.adult[1]) flags.push(`Above ${adultNote} (${d.adult[0]}–${d.adult[1]} ${d.unit})`);
  }
  if (m.type === "glucose") {
    if (v < 70) flags.push("Low glucose (<70 mg/dL) — review");
    else if (v > 600) flags.push("Very high glucose (>600 mg/dL) — confirm reading");
    else if (!child && m.context === "fasting" && v >= 126) flags.push("Fasting value above reference (≥126 mg/dL)");
    else if (!child && m.context !== "fasting" && v >= 200) flags.push("Above reference (≥200 mg/dL)");
  }
  return { errors, flags, child };
}

export function bmi(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function formatVital(m) {
  const d = VITAL_DEFS[m.type] || { label: m.type, unit: "" };
  if (m.type === "bp") return `${m.values.systolic}/${m.values.diastolic} mmHg`;
  if (m.type === "other") return `${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`;
  let s = `${m.value} ${m.unit || d.unit}`;
  if (m.type === "glucose") s += ` (${[GLUCOSE_CONTEXT[m.context], GLUCOSE_SOURCE[m.source]].filter(Boolean).join(", ")})`;
  if (m.type === "spo2" && m.context) s += ` (${m.context})`;
  return s;
}

export function vitalLabel(m) {
  return m.type === "other" ? m.name : VITAL_DEFS[m.type]?.label || m.type;
}

// BMI from the latest height and weight in a list of measurements.
export function bmiFrom(vitals) {
  const live = vitals.filter((v) => !v.voided);
  const last = (t) => live.filter((v) => v.type === t).sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1))[0];
  const h = last("height");
  const w = last("weight");
  return h && w ? bmi(h.value, w.value) : null;
}

// ---------------------------------------------------------------- diagnoses

// A later review creates a new diagnosis record with reviewOf = earlier id. The problem
// list shows the newest record of each chain; older records stay unchanged.
export function problemList(diagnoses) {
  const live = diagnoses.filter((d) => !d.voided);
  const reviewed = new Set(live.map((d) => d.reviewOf).filter(Boolean));
  return live
    .filter((d) => !reviewed.has(d.id) && d.kind !== "differential" && d.certainty !== "ruled_out" && d.status !== "resolved")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ------------------------------------------------------------- documentation

export const DEFAULT_REQUIRED = { complaint: true, vitals: false, diagnosis: true, exam: false };

export function missingDocumentation(enc, related, required = DEFAULT_REQUIRED) {
  const miss = [];
  if (enc.status === "cancelled") return miss;
  if (required.complaint && !(enc.complaints || []).some((c) => String(c.text || "").trim())) miss.push("Chief complaint");
  if (required.vitals && !related.vitals.some((v) => !v.voided)) miss.push("Vitals");
  if (required.exam && !(enc.exam || []).some((x) => x.status !== "not_examined")) miss.push("Examination");
  if (required.diagnosis && !related.diagnoses.some((d) => !d.voided && d.kind !== "differential")) miss.push("Diagnosis");
  return miss;
}

// Patients whose most recent encounter set a follow-up date on or before `until`,
// with no encounter since that one.
export function followUpsDue(encounters, until) {
  const latest = new Map();
  for (const e of encounters) {
    if (e.status === "cancelled") continue;
    const cur = latest.get(e.patientId);
    if (!cur || e.date > cur.date || (e.date === cur.date && (e.createdAt || 0) > (cur.createdAt || 0))) latest.set(e.patientId, e);
  }
  return [...latest.values()].filter((e) => e.followUpDate && e.followUpDate <= until).sort((a, b) => (a.followUpDate < b.followUpDate ? -1 : 1));
}

export function followUpDate(fromIso, interval) {
  const m = String(interval || "").match(/^(\d+)\s*([dwmy])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d") return addDays(fromIso, n);
  if (unit === "w") return addDays(fromIso, n * 7);
  const [y, mo, d] = fromIso.split("-").map(Number);
  const dt = unit === "m" ? new Date(y, mo - 1 + n, d) : new Date(y + n, mo - 1, d);
  return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
}

// A prescribed course is "possibly ongoing" until start + duration; after that it is
// shown as a past prescription, never as a current medicine.
export function courseEnd(item, prescribedOn) {
  if (item.stopDate) return item.stopDate;
  const m = String(item.duration || "").match(/(\d+)\s*(day|days|d|week|weeks|w|month|months|m)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2][0].toLowerCase();
  return addDays(item.startDate || prescribedOn, u === "d" ? n : u === "w" ? n * 7 : n * 30);
}

export function medicationNeedsVerification(med, today, days = 90) {
  if (med.status === "unknown") return true;
  if (!med.lastVerifiedAt) return true;
  return med.lastVerifiedAt < addDays(today, -days);
}

// ---------------------------------------------------------------------- note

export const DEFAULT_NOTE_TEMPLATE = {
  style: "standard", // or "soap"
  header: "",
  sections: { complaints: true, history: true, comorbidities: true, allergies: true, currentMeds: true, vitals: true, exam: true, investigations: true, diagnoses: true, treatment: true, advice: true, followUp: true },
};

function line(...parts) {
  return parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== "").join(" ");
}

// Builds the consultation note as plain structured sections (rendered to HTML/text by
// the UI). Only what was recorded for this encounter is included.
export function composeNote(ctx, template = DEFAULT_NOTE_TEMPLATE) {
  const { encounter: e, patient, profile, allergies = [], conditions = [], medications = [], vitals = [], diagnoses = [], investigations = [], prescriptions = [], locationName = "", doctorName = "" } = ctx;
  const on = template.sections;
  const S = {};
  S.complaints = (e.complaints || [])
    .filter((c) => String(c.text || "").trim())
    .map((c) => c.text + (c.duration ? ` × ${c.duration}` : "") + (c.onset ? `, onset ${c.onset}` : "") + (c.progression ? `, ${c.progression}` : "") + (c.severity ? `, severity ${c.severity}` : "") + (c.associated ? `; associated: ${c.associated}` : "") + (c.negatives ? `; no ${c.negatives}` : "") + (c.notes ? ` — ${c.notes}` : ""));
  const h = e.history || {};
  S.history = [h.hpi && `History of present illness: ${h.hpi}`, h.past && `Past history: ${h.past}`, h.surgical && `Surgical: ${h.surgical}`, h.family && `Family: ${h.family}`, h.personal && `Personal: ${h.personal}`, h.lifestyle && `Lifestyle: ${h.lifestyle}`].filter(Boolean);
  S.comorbidities = conditions.filter((c) => c.category === "medical" && c.status !== "resolved").map((c) => line(c.name, c.status === "uncertain" ? "(uncertain)" : "", c.onset ? `since ${c.onset}` : "", c.treatment ? `— on ${c.treatment}` : ""));
  const activeAllergies = allergies.filter((a) => a.status === "active");
  S.allergies = activeAllergies.length ? activeAllergies.map((a) => line(a.substance, a.reaction ? `→ ${a.reaction}` : "", a.severity ? `(${a.severity})` : "")) : profile && profile.nkda ? ["No known drug allergies"] : ["Allergy status not recorded"];
  S.currentMeds = medications.filter((m) => m.status === "taking").map((m) => line(m.name, m.strength, m.dose, m.frequency, "(patient-reported" + (m.lastVerifiedAt ? `, verified ${fmtDate(m.lastVerifiedAt)})` : ", not verified)")));
  const live = vitals.filter((v) => !v.voided).sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1));
  S.vitals = live.map((v) => line(`${v.takenAt.slice(11, 16)}`, `${vitalLabel(v)}: ${formatVital(v)}`, v.flags && v.flags.length ? `[${v.flags.join("; ")}]` : ""));
  const b = bmiFrom(live);
  if (b) S.vitals.push(`BMI ${b} kg/m²`);
  S.exam = (e.exam || []).filter((x) => x.status !== "not_examined").map((x) => line(`${x.label}: ${EXAM_STATUS[x.status]}.`, x.findings, x.positives ? `Positive: ${x.positives}.` : "", x.negatives ? `Negative: ${x.negatives}.` : ""));
  S.investigations = investigations.map((i) => line(fmtDate(i.resultAt || i.performedAt || i.orderedAt), i.name + ":", i.value !== undefined && i.value !== "" ? `${i.value}${i.unit ? " " + i.unit : ""}` : i.status === "ordered" ? "ordered" : "", i.refRange ? `(ref ${i.refRange})` : "", i.interpretation ? `— ${i.interpretation}` : ""));
  const dx = diagnoses.filter((d) => !d.voided);
  S.diagnoses = dx.map((d) => line(`${DIAGNOSIS_KINDS[d.kind]}:`, d.name, `(${CERTAINTY[d.certainty]})`, d.severity ? `— ${d.severity}` : "", d.code ? `[${d.code}]` : "", d.notes ? `— ${d.notes}` : ""));
  if (e.assessment) S.diagnoses.push(`Assessment: ${e.assessment}`);
  if (e.plan) S.diagnoses.push(`Plan: ${e.plan}`);
  const rx = prescriptions.filter((p) => p.status === "approved");
  S.treatment = rx.flatMap((p) => p.items.map((it, i) => line(`${i + 1}.`, it.drug, it.strength, "—", it.dose, it.route, it.frequency, it.timing, it.duration ? `× ${it.duration}` : "", it.quantity ? `(qty ${it.quantity})` : "", it.instructions ? `— ${it.instructions}` : "")));
  const draftRx = prescriptions.filter((p) => p.status === "draft");
  if (draftRx.length) S.treatment.push("[Unapproved draft prescription not included]");
  const a = e.advice || {};
  S.advice = [a.nonPharm && `Advice: ${a.nonPharm}`, a.diet && `Diet & lifestyle: ${a.diet}`, a.procedures && `Procedures: ${a.procedures}`, a.monitoring && `Monitoring: ${a.monitoring}`, a.warningSigns && `Return immediately if: ${a.warningSigns}`, a.referral && `Referral / admission: ${a.referral}`].filter(Boolean);
  const f = e.followUp || {};
  S.followUp = [f.date || f.interval ? line("Follow-up", f.interval ? `after ${f.interval}` : "", f.date ? `on ${fmtDate(f.date)}` : "") : "", f.instructions].filter(Boolean);

  const titles = { complaints: "Chief complaints", history: "History", comorbidities: "Comorbidities", allergies: "Allergies", currentMeds: "Current medications (reported)", vitals: "Vitals", exam: "Examination", investigations: "Investigations", diagnoses: "Assessment & diagnosis", treatment: "Treatment / prescription", advice: "Advice", followUp: "Follow-up" };
  const pick = (keys) => keys.filter((k) => on[k] !== false && S[k] && S[k].length).map((k) => ({ key: k, title: titles[k], lines: S[k] }));
  let sections;
  if (template.style === "soap") {
    sections = [
      { key: "S", title: "S — Subjective", parts: pick(["complaints", "history", "comorbidities", "allergies", "currentMeds"]) },
      { key: "O", title: "O — Objective", parts: pick(["vitals", "exam", "investigations"]) },
      { key: "A", title: "A — Assessment", parts: pick(["diagnoses"]) },
      { key: "P", title: "P — Plan", parts: pick(["treatment", "advice", "followUp"]) },
    ].filter((s) => s.parts.length);
  } else sections = pick(Object.keys(titles));
  if (e.notes) sections.push({ key: "notes", title: "Notes", lines: [e.notes] });
  return {
    header: template.header || "",
    patientLine: line(patient.name, `(${ageLabel(patient, e.date)}, ${patient.sex && patient.sex !== "unknown" ? patient.sex : "sex not recorded"})`, `· ${patient.id}`),
    encounterLine: line(fmtDate(e.date), e.time || "", "·", locationName, "·", ENCOUNTER_TYPES[e.type] || e.type, doctorName ? `· ${doctorName}` : ""),
    sections,
  };
}

export function noteToText(note) {
  const out = [];
  if (note.header) out.push(note.header, "");
  out.push(note.patientLine, note.encounterLine, "");
  for (const s of note.sections) {
    out.push(s.title.toUpperCase());
    if (s.parts) for (const p of s.parts) out.push(`  ${p.title}:`, ...p.lines.map((l) => "    " + l));
    else out.push(...s.lines.map((l) => "  " + l));
    out.push("");
  }
  return out.join("\n");
}
