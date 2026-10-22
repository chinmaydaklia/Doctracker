// Scanned-prescription workflow, installed onto Store: scan → review → approve → import.
//
// Safety rules enforced here (not only in the UI):
//  - nothing read from an image enters the record until the doctor approves each field
//    and then imports (doctor sign-off permission)
//  - an uncertain drug name / strength / dose / frequency / duration can only be
//    approved after the doctor types the value; other uncertain fields need an explicit
//    "checked against the image"
//  - an ambiguous diagnosis can never be imported as "confirmed"
//  - medicines are imported as UNVERIFIED medicine history (patient-reported list),
//    never as a prescription of this app and never as an instruction to dispense
//  - existing notes, findings and prescriptions are never overwritten: text is appended
//  - the original image is kept as an encrypted attachment; the raw extraction is
//    immutable; every field keeps its own history

import { Store, ValidationError, req, clean } from "./store.js";
import { newId } from "./ids.js";
import { isIsoDate, today, parseDMY } from "./dates.js";
import { checkVital, ageOf, normalizeName } from "./clinical.js";
import { toReviewFields, scanFlags, isUncertain, manualField, CRITICAL_MED_KEYS } from "./ocr/schema.js";
import { buildCatalogue } from "./ocr/medicines.js";
import { COMMON_INVESTIGATIONS, EXAM_SYSTEMS, CERTAINTY, DIAGNOSIS_KINDS, CONDITION_STATUS } from "./model.js";

const ALLOWED_BASE = /^(https:\/\/api\.anthropic\.com\/?|\/[^/].*)?$/;

function patientCheck(patient, ex, onDate) {
  if (!ex) return { result: "not_written", reasons: ["Manual entry"] };
  const p = ex.patient;
  const reasons = [];
  let mismatch = false;
  if (p.name.text) {
    const a = normalizeName(p.name.text).split(" ");
    const b = normalizeName(patient.name).split(" ");
    const common = a.filter((w) => w.length > 1 && b.includes(w)).length;
    if (common === 0) {
      mismatch = true;
      reasons.push(`Name on prescription “${p.name.text}” does not match “${patient.name}”`);
    } else reasons.push(`Name on prescription “${p.name.text}”`);
  }
  if (p.age.text) {
    const n = Number(String(p.age.text).match(/\d+/)?.[0]);
    const age = ageOf(patient, onDate);
    if (Number.isFinite(n) && age && Math.abs(age.years - n) > 3) {
      mismatch = true;
      reasons.push(`Age on prescription ${p.age.text} vs ${age.years} in the record`);
    }
  }
  if (p.sex.text && patient.sex && patient.sex !== "unknown") {
    const s = p.sex.text.trim().toLowerCase()[0];
    const r = patient.sex[0];
    if ((s === "m" || s === "f") && s !== r) {
      mismatch = true;
      reasons.push(`Sex on prescription ${p.sex.text} vs ${patient.sex} in the record`);
    }
  }
  if (!p.name.text && !p.age.text) return { result: "not_written", reasons: ["No patient name or age written on the prescription"] };
  return { result: mismatch ? "mismatch" : "match", reasons };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// Dates as handwritten in India: 12/3/26, 12-03-2026, 12.3.26, 12 Mar 2026 (day first).
// Returns ISO or null — never a guess for an unreadable date.
export function parseWrittenDate(text, todayIso = today()) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  let d, m, y;
  let r = t.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2}|\d{4})$/);
  if (r) [d, m, y] = [Number(r[1]), Number(r[2]), r[3]];
  else if ((r = t.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?[\s\-\/.]*([a-z]{3,5})[a-z]*[\s\-\/.,]*(\d{2}|\d{4})$/)) && MONTHS[r[2]]) [d, m, y] = [Number(r[1]), MONTHS[r[2]], r[3]];
  else return null;
  if (y.length === 2) {
    const cur = Number(todayIso.slice(2, 4));
    y = (Number(y) <= cur + 1 ? "20" : "19") + y;
  }
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

const guessCategory = (name) => COMMON_INVESTIGATIONS.find((x) => x[0].toLowerCase() === String(name).toLowerCase())?.[1] || "other";

// "140/90 mmHg" → measurement for addVitals; returns null when no number can be read.
export function parseVital(type, text, label) {
  const t = String(text || "");
  if (type === "bp") {
    const m = t.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
    return m ? { type: "bp", values: { systolic: Number(m[1]), diastolic: Number(m[2]) } } : null;
  }
  const m = t.match(/\d+(\.\d+)?/);
  if (!m) return null;
  if (type === "other") return { type: "other", name: label || "Observation", value: m[0], unit: t.replace(m[0], "").trim() };
  const v = { type, value: Number(m[0]) };
  if (type === "spo2" && /o2|oxygen|l\/min/i.test(t)) v.context = t;
  if (type === "glucose") {
    v.context = /fbs|fasting/i.test(t + label) ? "fasting" : /ppbs|pp|post/i.test(t + label) ? "pp" : "random";
    v.source = /cbg|gluco|capillary|grbs/i.test(t + label) ? "capillary" : "lab";
  }
  return v;
}

const ops = {
  // ------------------------------------------------------------- settings

  // Cloud reading settings are encrypted (they hold the doctor's API key).
  get ocrSettings() {
    const s = this.data.secrets.find((x) => x.id === "ocr");
    return s && !s._unreadable ? s : { id: "ocr", enabled: false, apiKey: "", baseURL: "" };
  },

  async saveOcrSettings({ enabled, apiKey, baseURL }) {
    this.requirePerm("clinical.sign");
    const base = clean(baseURL);
    req(ALLOWED_BASE.test(base), "Use the Anthropic API address or a path on this same site (e.g. /ai-proxy). Other addresses are blocked by the app's security policy.");
    if (enabled) req(clean(apiKey) || base.startsWith("/"), "Enter the API key (or a same-site proxy path).");
    const prev = this.ocrSettings;
    const rec = { id: "ocr", enabled: !!enabled, apiKey: clean(apiKey), baseURL: base, disclosureAcceptedAt: enabled ? prev.disclosureAcceptedAt || this.clock() : null, updatedAt: this.clock(), updatedBy: this.user };
    await this.commit([{ store: "secrets", put: rec }], [], { dataChange: true });
    await this.logClinical(enabled ? "enable-cloud-reading" : "disable-cloud-reading", "settings", "ocr");
  },

  medicineCatalogue() {
    const favs = this.data.templates.filter((t) => t.kind === "medicine").map((t) => ({ name: t.data.drug, generic: "", kind: "favourite" }));
    const extra = (this.data.templates.find((t) => t.kind === "catalogue")?.data.items || []).map((x) => ({ ...x, kind: "custom" }));
    // (templates of kind "catalogue" hold names only — no patient data)
    return buildCatalogue([...favs, ...extra]);
  },

  // ---------------------------------------------------------------- scans

  // Saves the original (and enhanced) image and the reader's result for review.
  async createScan({ patientId, encounterId = null, original, enhanced = null, provider, result = null, preprocess = null }) {
    this.requirePerm("clinical.write");
    const patient = this.get("patients", patientId);
    req(patient, "Choose the patient this prescription belongs to.");
    if (encounterId) req(this.get("encounters", encounterId)?.patientId === patientId, "That consultation belongs to another patient.");
    req(["claude", "manual"].includes(provider), "Unknown reader.");
    req(original && original.bytes && original.bytes.length, "No image.");
    if (provider !== "manual") req(result && result.extraction, "No reading result.");
    const scanId = newId("SC");
    const fOrig = await this.attachFile({ patientId, encounterId, name: original.name || "prescription", bytes: original.bytes, category: "prescription-scan", note: "Scanned prescription (original)" });
    const fEnh = enhanced ? await this.attachFile({ patientId, encounterId, name: "enhanced-" + (original.name || "prescription") + ".jpg", bytes: enhanced.bytes, category: "prescription-scan", note: "Scanned prescription (enhanced copy)" }) : null;
    const ex = result ? result.extraction : null;
    const now = this.clock();
    const scan = {
      id: scanId,
      patientId,
      encounterId,
      status: "review",
      provider,
      model: result?.model || null,
      requestId: result?.requestId || null,
      usage: result?.usage || null,
      validationErrors: result?.validationErrors || [],
      originalFileId: fOrig.id,
      enhancedFileId: fEnh ? fEnh.id : null,
      preprocess,
      extraction: ex, // immutable record of what the reader returned
      fields: ex ? toReviewFields(ex, { catalogue: this.medicineCatalogue() }) : [],
      flags: ex ? scanFlags(ex) : [],
      patientCheck: { ...patientCheck(patient, ex, today()), confirmedAt: null, confirmedBy: null },
      importLog: [],
      history: [{ at: now, by: this.user, action: provider === "manual" ? "created for manual entry" : `read by ${result.model}` }],
      createdAt: now,
      updatedAt: now,
      createdBy: this.user,
    };
    await this.commit([{ store: "scans", put: scan }]);
    await this.logClinical("scan", "scan", scanId, patientId);
    return scan;
  },

  _scan(id) {
    const s = this.get("scans", id);
    req(s, "Unknown scan.");
    return structuredClone(s);
  },

  async _saveScan(s, action, detail = "") {
    s.updatedAt = this.clock();
    s.history.push({ at: s.updatedAt, by: this.user, action, detail });
    await this.commit([{ store: "scans", put: s }]);
    return s;
  },

  // The patient chosen for the scan must be confirmed when the written details differ.
  async confirmScanPatient(scanId) {
    this.requirePerm("clinical.write");
    const s = this._scan(scanId);
    s.patientCheck.confirmedAt = this.clock();
    s.patientCheck.confirmedBy = this.user;
    return this._saveScan(s, "patient confirmed", this.get("patients", s.patientId)?.id);
  },

  // action: edit | approve | reject | reset | meta
  async reviewScanField(scanId, fieldId, { action, value, verified = false, meta = null, reason = "" }) {
    this.requirePerm("clinical.write");
    const s = this._scan(scanId);
    req(s.status !== "rejected", "This scan was rejected.");
    const f = s.fields.find((x) => x.id === fieldId);
    req(f, "Unknown field.");
    req(f.status !== "imported", "This field is already in the record. Correct it there.");
    const at = this.clock();
    const log = (entry) => f.history.push({ at, by: this.user, ...entry });
    if (action === "edit") {
      const v = clean(value);
      log({ action: "edit", from: f.value, to: v });
      f.value = v;
      f.edited = true;
      if (f.status === "approved") f.status = "pending"; // an edit needs re-approval
    } else if (action === "meta") {
      req(meta && typeof meta === "object", "Nothing to change.");
      if (meta.certainty) req(CERTAINTY[meta.certainty], "Invalid certainty.");
      if (meta.kind) req(DIAGNOSIS_KINDS[meta.kind], "Invalid diagnosis type.");
      if (meta.condStatus) req(CONDITION_STATUS[meta.condStatus], "Invalid status.");
      if (meta.status) req(["normal", "abnormal"].includes(meta.status), "Invalid examination status.");
      log({ action: "meta", from: { ...f.meta }, to: meta });
      Object.assign(f.meta, meta);
      if (f.status === "approved") f.status = "pending";
    } else if (action === "approve") {
      req(clean(f.value), "Nothing to approve: type the value or reject the field.");
      if (f.section === "medications" && CRITICAL_MED_KEYS.includes(f.key) && (isUncertain(f) || f.flags.some((x) => x.code === "missing")) && !f.edited) {
        throw new ValidationError(`${f.label}: the handwriting is uncertain. Type exactly what you read on the image before approving — it is never accepted as guessed.`);
      }
      if (f.flags.some((x) => x.code === "illegible") && !f.edited) throw new ValidationError(`${f.label}: illegible. Type it yourself or reject it.`);
      if (isUncertain(f) && !f.edited && !verified) throw new ValidationError(`${f.label}: uncertain reading. Confirm you checked it against the image, or edit it.`);
      if (f.section === "diagnoses" && f.meta.certainty === "confirmed" && isUncertain(f) && !f.edited) throw new ValidationError("An ambiguous handwritten diagnosis cannot be approved as confirmed. Choose provisional or suspected, or type the diagnosis yourself.");
      if (f.section === "examination") req(f.meta.status, "Choose whether this finding is normal or abnormal.");
      if (f.section === "comorbidities" && !f.meta.condStatus) f.meta.condStatus = f.meta.writtenAs === "known_case" && !isUncertain(f) ? "current" : "uncertain";
      f.status = "approved";
      f.verified = !!verified || !!f.edited;
      log({ action: "approve", verified: f.verified, edited: !!f.edited });
    } else if (action === "reject") {
      f.status = "rejected";
      log({ action: "reject", reason: clean(reason) });
    } else if (action === "reset") {
      f.status = "pending";
      log({ action: "reset" });
    } else throw new ValidationError("Unknown action.");
    return this._saveScan(s, `${action} ${f.label}`);
  },

  // Add a field the reader missed (or for a manual-entry scan). Counts as typed by the doctor.
  async addScanField(scanId, { section, group, key, label, value, meta = {} }) {
    this.requirePerm("clinical.write");
    const s = this._scan(scanId);
    req(s.status !== "rejected" && s.status !== "imported", "This scan is closed.");
    const f = manualField(section, group, key, label, meta);
    f.value = clean(value);
    f.edited = true;
    f.history.push({ at: this.clock(), by: this.user, action: "added manually", to: f.value });
    s.fields.push(f);
    return this._saveScan(s, `added ${label}`);
  },

  async rejectScan(scanId, reason) {
    this.requirePerm("clinical.write");
    const s = this._scan(scanId);
    req(!s.fields.some((f) => f.status === "imported"), "Part of this scan is already in the record; it cannot be rejected as a whole.");
    req(clean(reason), "Give a reason (e.g. wrong patient, unreadable, duplicate).");
    s.status = "rejected";
    s.rejectReason = clean(reason);
    return this._saveScan(s, "rejected", reason);
  },

  // Import every APPROVED field into the record. target: { mode: "encounter", encounterId }
  // (append to an editable consultation) or { mode: "new", locationId, date } (a new
  // "paper prescription" consultation, no fee). Validates everything before writing.
  async importScan(scanId, target) {
    this.requirePerm("clinical.sign");
    const s = this._scan(scanId);
    req(s.status !== "rejected", "This scan was rejected.");
    if (s.patientCheck.result === "mismatch") req(s.patientCheck.confirmedAt, "The patient details on the prescription differ from the selected patient. Confirm the patient first.");
    if (s.patientCheck.result === "not_written") req(s.patientCheck.confirmedAt, "Confirm this prescription belongs to the selected patient.");
    const approved = s.fields.filter((f) => f.status === "approved");
    req(approved.length, "Approve at least one field first.");
    const val = (section, group, key) => approved.find((f) => f.section === section && f.group === group && f.key === key)?.value || "";
    const groups = (section) => [...new Set(approved.filter((f) => f.section === section).map((f) => f.group))];

    // Target consultation
    let enc;
    const docDateText = val("document", "doc", "date");
    const docDate = parseWrittenDate(docDateText) || parseDMY(docDateText) || null;
    if (target.mode === "encounter") {
      enc = this._editable(target.encounterId);
      req(enc.patientId === s.patientId, "That consultation belongs to another patient.");
    } else {
      req(target.locationId && this.get("locations", target.locationId), "Choose where this prescription was written (or the nearest location).");
      req(!target.date || isIsoDate(target.date), "Date is invalid.");
    }
    const date = target.mode === "encounter" ? enc.date : target.date || docDate || today();

    // ---- validate everything first
    const problems = [];
    if (docDateText && !docDate && !target.date && target.mode !== "encounter") problems.push(`Prescription date “${docDateText}” cannot be read as a date. Edit it as DD-MM-YYYY, reject it, or choose the date.`);
    if (docDate && docDate > today()) problems.push(`Prescription date ${docDateText} is in the future. Check it.`);
    const age = ageOf(this.get("patients", s.patientId), date);
    const vitals = [];
    for (const f of approved.filter((x) => x.section === "vitals")) {
      const m = parseVital(f.meta.vitalType, f.value, f.label);
      if (!m) {
        problems.push(`${f.label}: no number to record (“${f.value}”). Edit it or reject it.`);
        continue;
      }
      const chk = checkVital(m, age ? age.years : NaN);
      if (chk.errors.length) problems.push(`${f.label}: ${chk.errors.join(" ")}`);
      vitals.push({ m, f });
    }
    for (const g of groups("medications")) if (!val("medications", g, "name")) problems.push(`Medicine ${g.slice(2) * 1 + 1}: approve its name, or reject the whole medicine.`);
    for (const f of approved.filter((x) => x.section === "diagnoses")) if (f.meta.certainty === "confirmed" && isUncertain(f) && !f.edited) problems.push(`${f.label}: cannot be confirmed from an ambiguous reading.`);
    if (problems.length) throw new ValidationError("Nothing was imported:\n" + problems.join("\n"));

    // ---- write
    const created = [];
    const src = (fieldIds) => ({ type: "scan", scanId, fieldIds });
    if (target.mode !== "encounter") {
      enc = await this.createEncounter({ patientId: s.patientId, date, locationId: target.locationId, type: "scan", workflow: "detailed", billing: { mode: "none" } });
      created.push({ store: "encounters", id: enc.id, fields: [] });
    }
    const e = structuredClone(this.get("encounters", enc.id));
    const marks = new Map(); // fieldId -> created record ref

    for (const g of groups("complaints")) {
      const ids = approved.filter((f) => f.section === "complaints" && f.group === g).map((f) => f.id);
      const text = val("complaints", g, "complaint");
      if (!text) continue;
      e.complaints.push({ text, duration: val("complaints", g, "duration"), onset: "", progression: "", severity: "", associated: "", negatives: "", notes: "From scanned prescription", source: src(ids) });
      ids.forEach((id) => marks.set(id, { store: "encounters", id: e.id }));
    }
    for (const f of approved.filter((x) => x.section === "examination")) {
      const sys = EXAM_SYSTEMS.find((x) => x.key === f.meta.system);
      let row = sys && e.exam.find((x) => x.key === sys.key);
      if (!row) {
        row = { key: "scan-" + f.id, label: "Other (from scanned prescription)", status: "not_examined", findings: "", positives: "", negatives: "" };
        e.exam.push(row);
      }
      // Never overwrite: an existing finding gets the scanned text appended.
      if (row.status === "not_examined" && !row.findings) {
        row.status = f.meta.status;
        row.findings = f.value;
      } else row.findings = [row.findings, `[from scanned prescription: ${f.value} (${f.meta.status})]`].filter(Boolean).join(" ");
      row.source = src([f.id]);
      marks.set(f.id, { store: "encounters", id: e.id });
    }
    const adv = approved.filter((x) => x.section === "advice");
    if (adv.length) {
      e.advice = e.advice || {};
      e.advice.nonPharm = [e.advice.nonPharm, ...adv.map((f) => f.value)].filter(Boolean).join("\n");
      adv.forEach((f) => marks.set(f.id, { store: "encounters", id: e.id }));
    }
    const fu = approved.filter((x) => x.section === "followup");
    if (fu.length) {
      e.followUp = e.followUp || {};
      const fuDate = parseWrittenDate(val("followup", "fu", "date")) || parseDMY(val("followup", "fu", "date"));
      if (!e.followUp.interval && val("followup", "fu", "interval")) e.followUp.interval = val("followup", "fu", "interval");
      if (!e.followUp.date && fuDate) e.followUp.date = fuDate;
      const extra = [val("followup", "fu", "instructions"), !fuDate && val("followup", "fu", "date") ? "Follow-up date as written: " + val("followup", "fu", "date") : ""].filter(Boolean).join(" ");
      if (extra) e.followUp.instructions = [e.followUp.instructions, extra].filter(Boolean).join(" ");
      fu.forEach((f) => marks.set(f.id, { store: "encounters", id: e.id }));
    }
    const docBits = [val("document", "doc", "prescriber") && "Prescriber: " + val("document", "doc", "prescriber"), val("document", "doc", "clinic") && "Clinic: " + val("document", "doc", "clinic"), val("document", "doc", "date") && "Dated: " + val("document", "doc", "date")].filter(Boolean);
    e.notes = [e.notes, `Imported from scanned prescription ${scanId}${docBits.length ? " — " + docBits.join("; ") : ""}.`].filter(Boolean).join("\n");
    approved.filter((f) => f.section === "document").forEach((f) => marks.set(f.id, { store: "encounters", id: e.id }));
    e.sources = [...(e.sources || []), { type: "scan", scanId }];
    await this.updateEncounter(e.id, { complaints: e.complaints, exam: e.exam, advice: e.advice, followUp: e.followUp, notes: e.notes, sources: e.sources });
    if (target.mode === "encounter") created.push({ store: "encounters", id: e.id, fields: [...marks.keys()] });

    if (vitals.length) {
      const recs = await this.addVitals(e.id, vitals.map(({ m }) => ({ ...m, note: "From scanned prescription (time not written)" })), { takenAt: `${date}T00:00` });
      for (let i = 0; i < recs.length; i++) {
        const fid = vitals[i].f.id;
        await this._stampSource("vitals", recs[i].id, src([fid]));
        marks.set(fid, { store: "vitals", id: recs[i].id });
        created.push({ store: "vitals", id: recs[i].id, fields: [fid] });
      }
    }
    for (const f of approved.filter((x) => x.section === "diagnoses")) {
      const d = await this.saveDiagnosis({ encounterId: e.id, kind: f.meta.kind, name: f.value, certainty: f.meta.certainty, notes: "From scanned prescription" + (f.meta.qualifier && f.meta.qualifier !== "none" ? ` (written as ${f.meta.qualifier})` : "") });
      await this._stampSource("diagnoses", d.id, src([f.id]));
      marks.set(f.id, { store: "diagnoses", id: d.id });
      created.push({ store: "diagnoses", id: d.id, fields: [f.id] });
    }
    for (const f of approved.filter((x) => x.section === "comorbidities")) {
      const c = await this.saveCondition({ patientId: s.patientId, category: "medical", name: f.value, status: f.meta.condStatus || "uncertain", notes: `From scanned prescription dated ${date}` });
      await this._stampSource("conditions", c.id, src([f.id]));
      marks.set(f.id, { store: "conditions", id: c.id });
      created.push({ store: "conditions", id: c.id, fields: [f.id] });
    }
    for (const g of groups("investigations")) {
      const ids = approved.filter((f) => f.section === "investigations" && f.group === g).map((f) => f.id);
      const name = val("investigations", g, "name");
      if (!name) continue;
      const result = val("investigations", g, "result");
      const kind = s.fields.find((f) => f.group === g && f.key === "name")?.meta.kind;
      const inv = await this.saveInvestigation({ patientId: s.patientId, encounterId: e.id, name, category: guessCategory(name), orderedAt: kind === "advised" ? date : null, resultAt: result ? date : null, value: result, interpretation: "From scanned prescription" });
      await this._stampSource("investigations", inv.id, src(ids));
      ids.forEach((id) => marks.set(id, { store: "investigations", id: inv.id }));
      created.push({ store: "investigations", id: inv.id, fields: ids });
    }
    for (const g of groups("medications")) {
      const ids = approved.filter((f) => f.section === "medications" && f.group === g).map((f) => f.id);
      const v = (k) => val("medications", g, k);
      const prescriber = val("document", "doc", "prescriber");
      const notes = [`From scanned prescription dated ${date}${prescriber ? " (" + prescriber + ")" : ""}`, v("form") && "form: " + v("form"), v("route") && "route: " + v("route"), v("timing") && "timing: " + v("timing"), v("duration") && "duration: " + v("duration"), v("quantity") && "qty: " + v("quantity"), v("instructions") && v("instructions"), "Not prescribed in this app — verify with the patient before relying on it."].filter(Boolean).join("; ");
      const m = await this.saveMedication({ patientId: s.patientId, name: v("name"), strength: v("strength"), dose: v("dose"), frequency: v("frequency"), since: date, status: "unknown", notes, verified: false });
      await this._stampSource("medications", m.id, src(ids));
      ids.forEach((id) => marks.set(id, { store: "medications", id: m.id }));
      created.push({ store: "medications", id: m.id, fields: ids });
    }

    // ---- mark the scan
    const s2 = this._scan(scanId);
    for (const f of s2.fields) {
      if (f.status !== "approved") continue;
      if (f.section === "patient") {
        f.status = "imported";
        f.importedTo = { note: "used to identify the patient only" };
      } else if (marks.has(f.id)) {
        f.status = "imported";
        f.importedTo = marks.get(f.id);
      }
      f.history.push({ at: this.clock(), by: this.user, action: "imported", to: f.importedTo });
    }
    s2.encounterId = s2.encounterId || e.id;
    s2.importLog.push({ at: this.clock(), by: this.user, encounterId: e.id, mode: target.mode, created });
    s2.status = s2.fields.every((f) => f.status === "imported" || f.status === "rejected") ? "imported" : "partially_imported";
    await this._saveScan(s2, "imported", `${created.length} records`);
    await this.logClinical("import", "scan", scanId, s.patientId);
    return { encounterId: e.id, created };
  },

  // Record where an imported record came from (provenance) without changing its content.
  async _stampSource(store, id, source) {
    const r = this.get(store, id);
    if (!r) return;
    await this.commit([{ store, put: { ...r, source } }]);
  },
};

Object.defineProperties(Store.prototype, Object.getOwnPropertyDescriptors(ops));
