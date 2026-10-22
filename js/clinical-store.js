// Clinical operations, installed onto Store. Rules enforced here (not only in the UI):
//  - a clinical record never creates a visit, a charge or a payment by itself; billing
//    happens only when the user explicitly asks for a new visit with the encounter
//  - a finalised encounter is read-only; corrections are amendments with a new signed version
//  - vitals are append-only (an error is voided with a reason, never edited)
//  - diagnoses from earlier encounters are reviewed by a new record, never overwritten
//  - investigation results and attachments are never replaced by newer ones
//  - prescriptions need the doctor's approval; editing an approved one makes a new version
//  - clinical content is encrypted at rest (see crypto.js); only links/status are in clear

import { Store, ValidationError, PermissionError, req, clean } from "./store.js";
import { newId } from "./ids.js";
import { isIsoDate, today } from "./dates.js";
import { checkVital, findPatientMatches, ageOf, composeNote, DEFAULT_NOTE_TEMPLATE, missingDocumentation, followUpsDue, DEFAULT_REQUIRED } from "./clinical.js";
import { EXAM_SYSTEMS, SEXES, ENCOUNTER_TYPES, DIAGNOSIS_KINDS, CERTAINTY, CONDITION_CATEGORIES, CONDITION_STATUS, ALLOWED_UPLOADS, MAX_UPLOAD_BYTES, INVESTIGATION_CATEGORIES } from "./model.js";
import { sealBytes, openBytes, sha256Hex } from "./crypto.js";
import { addDays } from "./dates.js";

function shortId(prefix) {
  return newId(prefix).replace(/^([A-Z]+-)(.{6}).*$/, "$1$2");
}

function nowIso(clock) {
  const d = new Date(clock());
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Detect the real type from the first bytes; the file name/extension is not trusted.
export function sniffType(bytes) {
  const b = bytes.subarray(0, 12);
  const is = (...sig) => sig.every((x, i) => x === null || b[i] === x);
  if (is(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (is(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (is(0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

const ops = {
  // ------------------------------------------------------------- audit (views)

  // Who viewed or changed which clinical record. Never stores clinical content.
  async logClinical(action, entity, entityId, patientId = null) {
    const now = this.clock();
    if (action === "view") {
      const key = `${this.session?.userId}|${entity}|${entityId}`;
      this._viewLog = this._viewLog || new Map();
      if (this._viewLog.get(key) > now - 10 * 60000) return; // one view entry per 10 min
      this._viewLog.set(key, now);
    }
    const rec = { id: newId("CA"), at: now, userId: this.session?.userId || null, user: this.user, role: this.session?.role || "owner", action, entity, entityId, patientId };
    await this.adapter.write([{ store: "clinicalAudit", put: rec }]);
    this.data.clinicalAudit.push(rec);
  },

  // ------------------------------------------------------------------ patients

  patientMatches(input) {
    return findPatientMatches(this.data.patients, input, today());
  },

  async registerPatient(input, { confirmNew = false } = {}) {
    this.requirePerm("patients");
    const p = this._validPatient(input);
    if (!confirmNew) {
      const matches = this.patientMatches(p);
      if (matches.length) return { needsConfirm: true, matches };
    }
    const now = this.clock();
    p.id = shortId("PT");
    while (this.get("patients", p.id)) p.id = shortId("PT");
    Object.assign(p, { registeredAt: input.registeredAt || today(), registeredBy: this.user, active: true, createdAt: now, updatedAt: now });
    await this.commit([{ store: "patients", put: p }], [{ action: "register", entity: "patient", entityId: p.id, after: p }]);
    return { patient: p };
  },

  _validPatient(input) {
    const name = clean(input.name);
    req(name, "Enter the patient's name.");
    const p = { name, nameHi: clean(input.nameHi), sex: input.sex || "unknown", dob: input.dob || null, ageYears: null, ageRecordedOn: null };
    req(SEXES[p.sex], "Invalid sex.");
    if (p.dob) {
      req(isIsoDate(p.dob) && p.dob <= today(), "Date of birth is invalid.");
    } else if (input.ageYears !== undefined && input.ageYears !== null && input.ageYears !== "") {
      const a = Number(input.ageYears);
      req(Number.isFinite(a) && a >= 0 && a <= 130, "Age must be 0–130 years.");
      p.ageYears = Math.floor(a);
      p.ageRecordedOn = input.ageRecordedOn || today();
    }
    const mob = clean(input.mobile).replace(/[\s-]/g, "");
    if (mob) req(/^(\+?91)?[6-9]\d{9}$/.test(mob) || /^\+?\d{8,15}$/.test(mob), "Mobile number looks wrong.");
    p.mobile = mob;
    p.address = clean(input.address);
    p.emergencyContact = { name: clean(input.emergencyContact?.name), relation: clean(input.emergencyContact?.relation), phone: clean(input.emergencyContact?.phone) };
    p.externalIds = (input.externalIds || []).filter((x) => clean(x.value)).map((x) => ({ label: clean(x.label) || "ID", value: clean(x.value) }));
    return p;
  },

  async updatePatient(id, input, reason = "") {
    this.requirePerm("patients");
    const before = this.get("patients", id);
    req(before, "Unknown patient.");
    const after = { ...before, ...this._validPatient({ ...before, ...input }), id, updatedAt: this.clock() };
    await this.commit([{ store: "patients", put: after }], [{ action: "update", entity: "patient", entityId: id, before, after, reason }]);
    return after;
  },

  // ---------------------------------------------------------- clinical profile

  _history(before, patch) {
    if (!before) return [];
    const { history = [], ...prev } = before;
    return [...history, { ...prev, changedAt: this.clock(), changedBy: this.user, changeReason: clean(patch.changeReason) }];
  },

  async saveProfile(patientId, input) {
    this.requirePerm("clinical.write");
    req(this.get("patients", patientId), "Unknown patient.");
    const before = this.get("profiles", patientId);
    const active = this.data.allergies.filter((a) => a.patientId === patientId && a.status === "active");
    if (input.nkda) req(!active.length, "Active allergies are recorded; mark them inactive before recording 'no known drug allergies'.");
    const p = { id: patientId, patientId, alerts: clean(input.alerts ?? before?.alerts), notes: clean(input.notes ?? before?.notes), nkda: input.nkda ?? before?.nkda ?? false, history: this._history(before, input), createdAt: before?.createdAt || this.clock(), updatedAt: this.clock() };
    await this.commit([{ store: "profiles", put: p }]);
    await this.logClinical("update", "profile", patientId, patientId);
    return p;
  },

  async saveAllergy(input) {
    this.requirePerm("clinical.write");
    req(this.get("patients", input.patientId), "Unknown patient.");
    req(clean(input.substance), "Enter the drug or substance.");
    const before = input.id ? this.get("allergies", input.id) : null;
    const a = { id: input.id || newId("AL"), patientId: input.patientId, substance: clean(input.substance), reaction: clean(input.reaction), severity: clean(input.severity), status: input.status || "active", notedAt: input.notedAt || before?.notedAt || today(), notes: clean(input.notes), history: this._history(before, input), createdAt: before?.createdAt || this.clock(), updatedAt: this.clock() };
    req(["active", "inactive", "entered_in_error"].includes(a.status), "Invalid allergy status.");
    const writes = [{ store: "allergies", put: a }];
    const prof = this.get("profiles", a.patientId);
    if (a.status === "active" && prof && prof.nkda) writes.push({ store: "profiles", put: { ...prof, nkda: false, updatedAt: this.clock() } });
    await this.commit(writes);
    await this.logClinical(before ? "update" : "create", "allergy", a.id, a.patientId);
    return a;
  },

  async saveCondition(input) {
    this.requirePerm("clinical.write");
    req(this.get("patients", input.patientId), "Unknown patient.");
    req(clean(input.name), "Enter the condition.");
    req(CONDITION_CATEGORIES[input.category || "medical"], "Invalid category.");
    const before = input.id ? this.get("conditions", input.id) : null;
    const c = { id: input.id || newId("CN"), patientId: input.patientId, category: input.category || "medical", name: clean(input.name), onset: clean(input.onset), status: input.status || "current", complications: clean(input.complications), treatment: clean(input.treatment), notes: clean(input.notes), history: this._history(before, input), createdAt: before?.createdAt || this.clock(), updatedAt: this.clock() };
    req(CONDITION_STATUS[c.status] || c.status === "entered_in_error", "Invalid status.");
    await this.commit([{ store: "conditions", put: c }]);
    await this.logClinical(before ? "update" : "create", "condition", c.id, c.patientId);
    return c;
  },

  // Medicines the patient reports already taking (not prescriptions).
  async saveMedication(input) {
    this.requirePerm("clinical.write");
    req(this.get("patients", input.patientId), "Unknown patient.");
    req(clean(input.name), "Enter the medicine.");
    const before = input.id ? this.get("medications", input.id) : null;
    const m = { id: input.id || newId("MD"), patientId: input.patientId, name: clean(input.name), strength: clean(input.strength), dose: clean(input.dose), frequency: clean(input.frequency), since: clean(input.since), status: input.status || "taking", source: "patient-reported", notes: clean(input.notes), lastVerifiedAt: input.verified ? today() : before?.lastVerifiedAt || null, verifiedBy: input.verified ? this.user : before?.verifiedBy || null, history: this._history(before, input), createdAt: before?.createdAt || this.clock(), updatedAt: this.clock() };
    req(["taking", "stopped", "unknown", "entered_in_error"].includes(m.status), "Invalid status.");
    await this.commit([{ store: "medications", put: m }]);
    await this.logClinical(before ? "update" : "create", "medication", m.id, m.patientId);
    return m;
  },

  // ---------------------------------------------------------------- encounters

  encounterForVisit(visitId) {
    return this.data.encounters.find((e) => e.visitId === visitId && e.status !== "cancelled") || null;
  },

  // billing.mode: "none" (no financial effect), "link" (existing visit), "new" (creates
  // exactly one visit, committed atomically with the encounter).
  async createEncounter(input) {
    this.requirePerm("clinical.write");
    const patient = this.get("patients", input.patientId);
    req(patient, "Choose the patient.");
    req(isIsoDate(input.date), "Date is invalid.");
    req(ENCOUNTER_TYPES[input.type || "opd"], "Invalid encounter type.");
    const billing = input.billing || { mode: "none" };
    const writes = [];
    const audits = [];
    let visitId = null;
    let sessionId = input.sessionId || null;
    let locationId = input.locationId || null;
    if (billing.mode === "link") {
      const v = this.get("visits", billing.visitId);
      req(v && !v.voided, "Unknown visit.");
      req(!this.encounterForVisit(v.id), "That visit already has a clinical record.");
      req(!v.patientRecordId || v.patientRecordId === patient.id, "That visit belongs to another patient.");
      visitId = v.id;
      sessionId = v.sessionId;
      locationId = v.locationId;
      if (!v.patientRecordId) {
        const after = { ...v, patientRecordId: patient.id, updatedAt: this.clock() };
        writes.push({ store: "visits", put: after });
        audits.push({ action: "link-patient", entity: "visit", entityId: v.id, before: v, after });
      }
    } else if (billing.mode === "new") {
      const r = this._visitOps({ ...billing, date: input.date, locationId: input.locationId, sessionName: input.sessionName, patientRecordId: patient.id }, { allowDuplicate: true });
      writes.push(...r.ops);
      audits.push(...r.audits);
      visitId = r.visit.id;
      sessionId = r.session.id;
      locationId = r.session.locationId;
    } else {
      req(billing.mode === "none", "Invalid billing choice.");
      if (sessionId) {
        const s = this.get("sessions", sessionId);
        req(s && !s.voided, "Unknown session.");
        locationId = s.locationId;
      }
    }
    req(locationId && this.get("locations", locationId), "Choose the location.");
    const doctor = input.doctorId ? this.data.users.find((u) => u.id === input.doctorId) : null;
    const now = this.clock();
    const e = {
      id: newId("E"),
      patientId: patient.id,
      visitId,
      sessionId,
      locationId,
      date: input.date,
      time: input.time || nowIso(this.clock).slice(11),
      type: input.type || "opd",
      workflow: input.workflow === "detailed" ? "detailed" : "quick",
      doctorId: doctor ? doctor.id : this.session?.userId || null,
      doctorName: doctor ? doctor.name : this.session?.name || "",
      status: "draft",
      complaints: [],
      history: {},
      exam: EXAM_SYSTEMS.map((x) => ({ key: x.key, label: x.label, status: "not_examined", findings: "", positives: "", negatives: "" })),
      assessment: "",
      plan: "",
      advice: {},
      followUp: {},
      followUpDate: null,
      notes: "",
      version: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: this.user,
    };
    writes.push({ store: "encounters", put: e });
    await this.commit(writes, audits);
    await this.logClinical("create", "encounter", e.id, e.patientId);
    return e;
  },

  _editable(encounterId) {
    const e = this.get("encounters", encounterId);
    req(e, "Unknown encounter.");
    req(e.status === "draft" || e.status === "amending", e.status === "finalized" ? "This consultation is signed. Start an amendment to change it." : "This consultation is cancelled.");
    return e;
  },

  async updateEncounter(id, patch) {
    this.requirePerm("clinical.write");
    const before = this._editable(id);
    const allowed = ["complaints", "history", "exam", "assessment", "plan", "advice", "followUp", "notes", "type", "workflow", "time", "doctorId"];
    const after = { ...before, updatedAt: this.clock() };
    for (const k of allowed) if (patch[k] !== undefined) after[k] = structuredClone(patch[k]);
    if (patch.doctorId) {
      const d = this.data.users.find((u) => u.id === patch.doctorId && u.role === "doctor");
      req(d, "Choose a doctor.");
      after.doctorName = d.name;
    }
    for (const c of after.complaints) {
      req(typeof c.text === "string", "Invalid complaint.");
      if (!c.id) c.id = newId("CC");
    }
    for (const x of after.exam) req(["not_examined", "normal", "abnormal"].includes(x.status), "Invalid examination status.");
    after.followUpDate = after.followUp && after.followUp.date && isIsoDate(after.followUp.date) ? after.followUp.date : null;
    await this.commit([{ store: "encounters", put: after }]);
    return after;
  },

  async finalizeEncounter(id, { template } = {}) {
    this.requirePerm("clinical.sign");
    const e = this._editable(id);
    const rel = this._related(id);
    req(!rel.prescriptions.some((p) => p.status === "draft"), "Approve or discard the draft prescription first.");
    const n = (e.version || 0) + 1;
    const note = composeNote(this._noteContext(e), template || this.noteTemplate);
    const now = this.clock();
    const version = {
      id: newId("NV"),
      encounterId: id,
      patientId: e.patientId,
      version: n,
      kind: n === 1 ? "original" : "amendment",
      reason: n === 1 ? "" : e.amendReason || "",
      note,
      snapshot: { encounter: e, ...rel },
      signedBy: this.user,
      signedById: this.session?.userId || null,
      signedAt: now,
      createdAt: now,
    };
    const after = { ...e, status: "finalized", version: n, finalizedAt: now, finalizedBy: this.user, amendReason: "", updatedAt: now };
    await this.commit([{ store: "noteVersions", put: version }, { store: "encounters", put: after }]);
    await this.logClinical(n === 1 ? "sign" : "sign-amendment", "encounter", id, e.patientId);
    return { encounter: after, version };
  },

  async amendEncounter(id, reason) {
    this.requirePerm("clinical.sign");
    const e = this.get("encounters", id);
    req(e && e.status === "finalized", "Only a signed consultation can be amended.");
    req(clean(reason), "Give the reason for the amendment.");
    const after = { ...e, status: "amending", amendReason: clean(reason), updatedAt: this.clock() };
    await this.commit([{ store: "encounters", put: after }]);
    await this.logClinical("amend", "encounter", id, e.patientId);
    return after;
  },

  // Clinical cancellation only. The linked financial visit is NOT touched; cancelling
  // the charge is a separate, separately audited action (Store.cancelVisit).
  async cancelEncounter(id, reason) {
    this.requirePerm("clinical.write");
    const e = this.get("encounters", id);
    req(e && e.status !== "cancelled", "Unknown encounter.");
    req(clean(reason), "Give a reason.");
    const after = { ...e, status: "cancelled", cancelReason: clean(reason), cancelledAt: this.clock(), updatedAt: this.clock() };
    await this.commit([{ store: "encounters", put: after }]);
    await this.logClinical("cancel", "encounter", id, e.patientId);
    return after;
  },

  _related(encounterId) {
    const by = (s) => this.data[s].filter((r) => r.encounterId === encounterId);
    return { vitals: by("vitals"), diagnoses: by("diagnoses"), investigations: by("investigations"), prescriptions: by("prescriptions"), files: by("files") };
  },

  get noteTemplate() {
    const t = this.data.templates.find((x) => x.kind === "note");
    return t ? { ...DEFAULT_NOTE_TEMPLATE, ...t.data, sections: { ...DEFAULT_NOTE_TEMPLATE.sections, ...(t.data.sections || {}) } } : DEFAULT_NOTE_TEMPLATE;
  },

  _noteContext(e) {
    const pid = e.patientId;
    const rel = this._related(e.id);
    return {
      encounter: e,
      patient: this.get("patients", pid),
      profile: this.get("profiles", pid),
      allergies: this.data.allergies.filter((a) => a.patientId === pid),
      conditions: this.data.conditions.filter((c) => c.patientId === pid && c.status !== "entered_in_error"),
      medications: this.data.medications.filter((m) => m.patientId === pid),
      ...rel,
      locationName: this.locationName(e.locationId),
      doctorName: e.doctorName,
    };
  },

  // ------------------------------------------------------------------- vitals

  async addVitals(encounterId, measurements, { takenAt, confirmUnusual = false } = {}) {
    this.requirePerm("vitals");
    const e = this._editable(encounterId);
    const p = this.get("patients", e.patientId);
    const age = ageOf(p, e.date);
    const at = takenAt || nowIso(this.clock);
    req(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at), "Measurement time is invalid.");
    const recs = [];
    const problems = [];
    for (const m of measurements) {
      const chk = checkVital(m, age ? age.years : NaN);
      if (chk.errors.length) problems.push(...chk.errors);
      const flags = [...chk.flags];
      if (chk.errors.length && confirmUnusual) flags.push("Value confirmed by user despite plausibility warning: " + chk.errors.join(" "));
      if (chk.child) flags.push("Age <18: adult reference ranges not applied");
      recs.push({ id: newId("VT"), patientId: e.patientId, encounterId, takenAt: at, type: m.type, values: m.values || null, value: m.value ?? null, unit: m.unit || null, name: clean(m.name), context: m.context || "", source: m.source || "", note: clean(m.note), flags, enteredBy: this.user, voided: false, createdAt: this.clock() });
    }
    if (problems.length && !confirmUnusual) throw new ValidationError("Check these values (nothing was saved):\n" + problems.join("\n"));
    req(recs.length, "Enter at least one measurement.");
    await this.commit(recs.map((r) => ({ store: "vitals", put: r })));
    await this.logClinical("create", "vitals", encounterId, e.patientId);
    return recs;
  },

  async voidVital(id, reason) {
    this.requirePerm("vitals");
    const v = this.get("vitals", id);
    req(v && !v.voided, "Unknown measurement.");
    this._editable(v.encounterId);
    req(clean(reason), "Give a reason.");
    await this.commit([{ store: "vitals", put: { ...v, voided: true, voidReason: clean(reason), voidedAt: this.clock(), voidedBy: this.user } }]);
    await this.logClinical("void", "vitals", id, v.patientId);
  },

  // ----------------------------------------------------------------- diagnoses

  async saveDiagnosis(input) {
    this.requirePerm("clinical.write");
    const e = this._editable(input.encounterId);
    req(clean(input.name), "Enter the diagnosis.");
    req(DIAGNOSIS_KINDS[input.kind], "Choose primary / secondary / differential.");
    req(CERTAINTY[input.certainty], "Choose how certain the diagnosis is.");
    const before = input.id ? this.get("diagnoses", input.id) : null;
    if (before) req(before.encounterId === e.id, "Diagnoses from an earlier consultation are reviewed, not edited.");
    if (input.reviewOf) {
      const prev = this.get("diagnoses", input.reviewOf);
      req(prev && prev.patientId === e.patientId, "Unknown earlier diagnosis.");
      req(prev.encounterId !== e.id, "Review a diagnosis from an earlier consultation.");
    }
    const d = { id: before?.id || newId("DX"), patientId: e.patientId, encounterId: e.id, kind: input.kind, name: clean(input.name), code: clean(input.code), certainty: input.certainty, severity: clean(input.severity), notes: clean(input.notes), status: input.status === "resolved" ? "resolved" : "active", reviewOf: input.reviewOf || before?.reviewOf || null, voided: false, createdAt: before?.createdAt || this.clock(), updatedAt: this.clock() };
    await this.commit([{ store: "diagnoses", put: d }]);
    return d;
  },

  async removeDiagnosis(id) {
    this.requirePerm("clinical.write");
    const d = this.get("diagnoses", id);
    req(d && !d.voided, "Unknown diagnosis.");
    this._editable(d.encounterId);
    await this.commit([{ store: "diagnoses", put: { ...d, voided: true, updatedAt: this.clock() } }]);
  },

  // ------------------------------------------------------------ investigations

  async saveInvestigation(input) {
    this.requirePerm("investigations");
    req(this.get("patients", input.patientId), "Unknown patient.");
    if (input.encounterId) {
      const e = this.get("encounters", input.encounterId);
      req(e && e.patientId === input.patientId, "That consultation belongs to another patient.");
    }
    req(clean(input.name), "Enter the investigation name.");
    req(INVESTIGATION_CATEGORIES[input.category || "other"], "Invalid category.");
    for (const k of ["orderedAt", "performedAt", "resultAt"]) if (input[k]) req(isIsoDate(input[k]), "Dates must be valid.");
    const before = input.id ? this.get("investigations", input.id) : null;
    const hasResult = (x) => x && (clean(x.value) !== "" || x.resultAt);
    if (before && hasResult(before)) {
      // A recorded result is never overwritten: a newer result is a new record.
      for (const k of ["value", "unit", "resultAt", "refRange"]) req(clean(input[k] ?? before[k]) === clean(before[k]), "This result is already recorded. Add a new result instead of changing it.");
    }
    const value = clean(input.value);
    const inv = {
      id: before?.id || newId("IN"),
      patientId: input.patientId,
      encounterId: input.encounterId || before?.encounterId || null,
      name: clean(input.name),
      category: input.category || "other",
      orderedAt: input.orderedAt || before?.orderedAt || null,
      performedAt: input.performedAt || null,
      resultAt: input.resultAt || (value ? input.performedAt || today() : null),
      value,
      unit: clean(input.unit),
      refRange: clean(input.refRange),
      interpretation: clean(input.interpretation),
      orderedBy: clean(input.orderedBy) || before?.orderedBy || this.session?.name || "",
      status: value || input.resultAt ? "resulted" : "ordered",
      history: this._history(before, input),
      createdAt: before?.createdAt || this.clock(),
      updatedAt: this.clock(),
    };
    await this.commit([{ store: "investigations", put: inv }]);
    await this.logClinical(before ? "update" : "create", "investigation", inv.id, inv.patientId);
    return inv;
  },

  // Attachments: type checked from content, encrypted, stored in IndexedDB (never
  // localStorage). Always appended; nothing is replaced.
  async attachFile({ patientId, encounterId = null, investigationId = null, name, bytes, category = "other", note = "" }) {
    this.requirePerm("investigations");
    req(this.get("patients", patientId), "Unknown patient.");
    req(bytes && bytes.length, "The file is empty.");
    req(bytes.length <= MAX_UPLOAD_BYTES, `Files must be under ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB.`);
    const mime = sniffType(bytes);
    req(mime && ALLOWED_UPLOADS[mime], "Only PDF, JPEG, PNG or WebP files can be attached.");
    if (investigationId) req(this.get("investigations", investigationId)?.patientId === patientId, "That report belongs to another patient.");
    if (encounterId) req(this.get("encounters", encounterId)?.patientId === patientId, "That consultation belongs to another patient.");
    const id = newId("F");
    const sealed = await sealBytes(this.dek, bytes);
    const f = { id, patientId, encounterId, investigationId, name: clean(name).slice(0, 120) || "report", mime, size: bytes.length, sha256: await sha256Hex(bytes), category, note: clean(note), uploadedBy: this.user, createdAt: this.clock() };
    await this.commit([{ store: "blobs", put: { id, iv: sealed.iv, data: sealed.data } }, { store: "files", put: f }]);
    await this.logClinical("upload", "file", id, patientId);
    return f;
  },

  async readFile(id) {
    this.requirePerm("investigations");
    const f = this.get("files", id);
    req(f, "Unknown file.");
    const blob = await this.adapter.get("blobs", id);
    req(blob, "The file data is missing.");
    const bytes = await openBytes(this.dek, blob.iv, blob.data);
    await this.logClinical("view", "file", id, f.patientId);
    return { ...f, bytes };
  },

  // ------------------------------------------------------------- prescriptions

  _cleanItems(items) {
    return (items || [])
      .map((it) => ({ drug: clean(it.drug), strength: clean(it.strength), dose: clean(it.dose), route: clean(it.route), frequency: clean(it.frequency), timing: clean(it.timing), duration: clean(it.duration), quantity: clean(it.quantity), instructions: clean(it.instructions), startDate: it.startDate || null, stopDate: it.stopDate || null, status: it.status || "active" }))
      .filter((it) => it.drug);
  },

  // Draft: edited in place. Approved: editing creates a new draft version (supersedes).
  async savePrescription(input) {
    this.requirePerm("clinical.write");
    const e = this._editable(input.encounterId);
    const before = input.id ? this.get("prescriptions", input.id) : null;
    const items = this._cleanItems(input.items);
    const now = this.clock();
    if (before && before.status === "draft") {
      const p = { ...before, items, notes: clean(input.notes), updatedAt: now };
      await this.commit([{ store: "prescriptions", put: p }]);
      return p;
    }
    if (before) req(before.status === "approved", "This prescription cannot be edited.");
    const p = { id: newId("RX"), patientId: e.patientId, encounterId: e.id, items, notes: clean(input.notes), status: "draft", supersedes: before ? before.id : null, version: before ? (before.version || 1) + 1 : 1, createdBy: this.user, createdAt: now, updatedAt: now };
    await this.commit([{ store: "prescriptions", put: p }]);
    return p;
  },

  async approvePrescription(id) {
    this.requirePerm("clinical.sign");
    const p = this.get("prescriptions", id);
    req(p && p.status === "draft", "Only a draft prescription can be approved.");
    this._editable(p.encounterId);
    req(p.items.length, "Add at least one medicine.");
    for (const it of p.items) req(it.dose || it.instructions, `Enter the dose or instructions for ${it.drug}.`), req(it.frequency || it.instructions, `Enter how often to take ${it.drug}.`);
    const now = this.clock();
    const writes = [{ store: "prescriptions", put: { ...p, status: "approved", approvedBy: this.user, approvedById: this.session?.userId || null, approvedAt: now, updatedAt: now } }];
    if (p.supersedes) {
      const old = this.get("prescriptions", p.supersedes);
      if (old && old.status === "approved") writes.push({ store: "prescriptions", put: { ...old, status: "superseded", supersededBy: p.id, updatedAt: now } });
    }
    await this.commit(writes);
    await this.logClinical("approve", "prescription", id, p.patientId);
  },

  async discardPrescription(id, reason = "Discarded draft") {
    this.requirePerm("clinical.write");
    const p = this.get("prescriptions", id);
    req(p && (p.status === "draft" || p.status === "approved"), "Unknown prescription.");
    this._editable(p.encounterId);
    await this.commit([{ store: "prescriptions", put: { ...p, status: "cancelled", cancelReason: clean(reason), updatedAt: this.clock() } }]);
  },

  // ------------------------------------------------------------------ templates

  async saveTemplate(input) {
    this.requirePerm("clinical.write");
    req(["complaint", "exam", "prescription", "medicine", "note", "advice"].includes(input.kind), "Invalid template type.");
    req(clean(input.name) || input.kind === "note", "Name the template.");
    const t = { id: input.id || newId("TP"), kind: input.kind, name: clean(input.name) || "Note layout", data: structuredClone(input.data), createdAt: this.clock(), updatedAt: this.clock() };
    await this.commit([{ store: "templates", put: t }], [], { dataChange: true });
    return t;
  },

  async deleteTemplate(id) {
    this.requirePerm("clinical.write");
    await this.commit([{ store: "templates", del: id }]);
  },

  // -------------------------------------------------------------------- reading

  // Everything clinical about one patient. Doctors only (staff see vitals/reports).
  patientRecord(patientId) {
    this.requirePerm("clinical.read");
    const by = (s) => this.data[s].filter((r) => r.patientId === patientId);
    this.logClinical("view", "patient", patientId, patientId);
    return {
      patient: this.get("patients", patientId),
      profile: this.get("profiles", patientId),
      allergies: by("allergies"),
      conditions: by("conditions"),
      medications: by("medications"),
      encounters: by("encounters").sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt)),
      vitals: by("vitals"),
      diagnoses: by("diagnoses"),
      investigations: by("investigations"),
      prescriptions: by("prescriptions"),
      files: by("files"),
      notes: by("noteVersions"),
    };
  },

  encounterBundle(id) {
    this.requirePerm("clinical.read");
    const e = this.get("encounters", id);
    req(e, "Unknown encounter.");
    this.logClinical("view", "encounter", id, e.patientId);
    return { encounter: e, ...this._related(id), versions: this.data.noteVersions.filter((v) => v.encounterId === id).sort((a, b) => a.version - b.version), context: this._noteContext(e) };
  },

  // Staff (vitals / reports only): no complaints, diagnoses, notes or prescriptions.
  staffEncounterView(id) {
    this.requirePerm("vitals");
    const e = this.get("encounters", id);
    req(e, "Unknown encounter.");
    const r = this._related(id);
    this.logClinical("view", "encounter-vitals", id, e.patientId);
    return { encounter: { id: e.id, patientId: e.patientId, date: e.date, locationId: e.locationId, status: e.status, type: e.type }, vitals: r.vitals, investigations: r.investigations, files: r.files };
  },

  noteFor(encounterId, template) {
    this.requirePerm("clinical.read");
    const e = this.get("encounters", encounterId);
    req(e, "Unknown encounter.");
    return composeNote(this._noteContext(e), template || this.noteTemplate);
  },

  // Dashboard numbers. Counts use clear metadata, so they work for every role;
  // missing documentation needs the content (doctor only).
  clinicalMetrics(todayIso) {
    const enc = this.data.encounters;
    const month = todayIso.slice(0, 7);
    const live = enc.filter((e) => e.status !== "cancelled");
    const signedToday = live.filter((e) => e.date === todayIso && e.status === "finalized").length;
    const signedMonth = live.filter((e) => e.date.startsWith(month) && e.status === "finalized").length;
    const pending = live.filter((e) => e.status === "draft" || e.status === "amending");
    const due = followUpsDue(live, addDays(todayIso, 7));
    const linked = new Set(live.map((e) => e.visitId).filter(Boolean));
    const visitsNoRecord = this.data.visits.filter((v) => !v.voided && !v.cancelled && v.date === todayIso && v.patientRecordId && !linked.has(v.id));
    let missing = null;
    if (this.can("clinical.read")) {
      const req = (this.data.templates.find((t) => t.kind === "note")?.data.required) || DEFAULT_REQUIRED;
      missing = live.filter((e) => e.date.startsWith(month)).map((e) => ({ encounter: e, missing: missingDocumentation(e, this._related(e.id), req) })).filter((x) => x.missing.length);
    }
    return { signedToday, signedMonth, pending, due, visitsNoRecord, missing };
  },
};

Object.defineProperties(Store.prototype, Object.getOwnPropertyDescriptors(ops));
export { ValidationError, PermissionError };
