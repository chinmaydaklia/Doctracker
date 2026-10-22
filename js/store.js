// Domain service: validated, audited operations over the records.
// Every operation builds a list of writes (including its audit-log entry) and commits
// them in ONE IndexedDB transaction; memory is updated only after the write succeeds.
// Financial records are never hard-deleted: they are voided, reversed or corrected.

import { STORES, DATA_STORES, LAZY_STORES, CLINICAL_STORES, CLINICAL_META, PERMISSIONS, OWNER_PERMISSIONS, METHODS, AGREEMENT_TYPES, REVENUE_BASES, FREQUENCIES, ARRANGEMENTS } from "./model.js";
import { sealJSON, openJSON } from "./crypto.js";
import { newId, newSessionId, newVisitId } from "./ids.js";
import { isIsoDate, today } from "./dates.js";
import { isPaise, sum, fmtINR } from "./money.js";
import { computeLedger, rateFor, computeSettlement, mapBy } from "./calc.js";

export class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ValidationError";
  }
}

export class PermissionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "PermissionError";
  }
}

// Which permission a write to each store needs. Checked centrally in commit(), so no
// operation (UI or otherwise) can bypass it.
const WRITE_PERMISSION = {
  locations: "finance.admin",
  rates: "finance.admin",
  payers: "finance.admin",
  agreements: "finance.admin",
  settlements: "finance.admin",
  sessions: "finance",
  visits: "finance",
  payments: "finance",
  allocations: "finance",
  adjustments: "finance",
  patients: "patients",
  profiles: "clinical.write",
  conditions: "clinical.write",
  allergies: "clinical.write",
  medications: "clinical.write",
  encounters: "clinical.write",
  diagnoses: "clinical.write",
  prescriptions: "clinical.write",
  noteVersions: "clinical.sign",
  templates: "clinical.write",
  vitals: "vitals",
  investigations: "investigations",
  files: "investigations",
  blobs: "investigations",
  users: "users",
  scans: "clinical.write",
  secrets: "clinical.sign",
};

function req(cond, msg) {
  if (!cond) throw new ValidationError(msg);
}
const isAmount = (v) => isPaise(v) && v >= 0;
const clean = (s) => (s === undefined || s === null ? "" : String(s).trim());

// Patient identifiers are kept out of the audit log.
const PII = ["patientName", "patientId"];
const PATIENT_PII = ["name", "nameHi", "mobile", "address", "emergencyContact", "dob", "externalIds"];
function redact(obj, entity) {
  if (!obj) return obj;
  const o = structuredClone(obj);
  for (const k of entity === "patient" ? [...PII, ...PATIENT_PII] : PII) if (o[k]) o[k] = "[redacted]";
  return o;
}

export class Store {
  constructor(adapter, { clock = () => Date.now() } = {}) {
    this.adapter = adapter;
    this.clock = clock;
    this.data = Object.fromEntries(STORES.map((s) => [s, []]));
    this._ledger = null;
    this._listeners = new Set();
    this.session = null; // { userId, name, role, perms } once someone signs in
    this.dek = null; // clinical data key, only while a clinical user is signed in
    this._sealed = Object.fromEntries(CLINICAL_STORES.map((s) => [s, []]));
  }

  static async open(adapter, opts) {
    const s = new Store(adapter, opts);
    await s.reload();
    return s;
  }

  async reload() {
    const all = await this.adapter.loadAll();
    for (const s of STORES) {
      if (LAZY_STORES.includes(s)) continue;
      if (CLINICAL_STORES.includes(s)) this._sealed[s] = all[s] || [];
      else this.data[s] = all[s] || [];
    }
    await this._openClinical();
    this._ledger = null;
    this._emit();
  }

  // With the key: decrypt every clinical record into memory. Without it: keep only the
  // clear metadata (links, dates, status), so counts work but no content is readable.
  async _openClinical() {
    for (const s of CLINICAL_STORES) {
      const sealed = this._sealed[s];
      if (!this.dek) {
        this.data[s] = sealed.map((r) => metaOf(s, r));
        continue;
      }
      const out = [];
      for (const r of sealed) {
        try {
          out.push({ ...(await openJSON(this.dek, r.enc)), id: r.id });
        } catch {
          out.push({ ...metaOf(s, r), _unreadable: true });
        }
      }
      this.data[s] = out;
    }
  }

  get authEnabled() {
    return this.data.users.some((u) => u.active !== false);
  }

  get perms() {
    if (this.session) return this.session.perms;
    return this.authEnabled ? [] : OWNER_PERMISSIONS;
  }

  can(perm) {
    return this.perms.includes(perm) && (!perm.startsWith("clinical") || !!this.dek || perm === "clinical.audit");
  }

  requirePerm(perm) {
    if (!this.perms.includes(perm)) throw new PermissionError(`Your account (${this.session ? this.session.role : "not signed in"}) is not allowed to do this.`);
    if ((perm.startsWith("clinical") || perm === "vitals" || perm === "investigations") && !this.dek) throw new PermissionError("Clinical records are locked. Sign in with a clinical account.");
  }

  // Start a signed-in session. `dek` only for users that hold a wrapped key.
  async startSession(user, dek) {
    const base = PERMISSIONS[user.role] || [];
    const perms = user.role === "staff" && !user.canClinical ? base.filter((p) => p === "patients") : base;
    this.session = { userId: user.id, name: user.name, role: user.role, perms, at: this.clock() };
    this.dek = dek || null;
    await this._openClinical();
    this._ledger = null;
    this._emit();
  }

  async endSession() {
    this.session = null;
    this.dek = null;
    await this._openClinical(); // drops decrypted content from memory
    this._ledger = null;
    this._emit();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emit() {
    for (const fn of this._listeners) fn();
  }

  get ledger() {
    if (!this._ledger) this._ledger = computeLedger(this.data);
    return this._ledger;
  }

  get(store, id) {
    return this.data[store].find((r) => r.id === id) || null;
  }

  get settings() {
    return this.get("meta", "settings") || { id: "settings", userName: "Doctor", showHindi: false, lastLocationId: null, lastSessionName: "morning" };
  }
  get backupMeta() {
    return this.get("meta", "backup") || { id: "backup", lastBackupAt: null, lastChangeAt: null, lastVerifiedAt: null };
  }
  get user() {
    if (this.session) return `${this.session.name} (${this.session.role})`;
    return this.settings.userName || "Doctor";
  }

  // Apply ops to memory after a successful write.
  _apply(ops) {
    for (const o of ops) {
      const arr = this.data[o.store];
      if (o.clear) arr.length = 0;
      else if (o.del !== undefined) {
        const i = arr.findIndex((r) => r.id === o.del);
        if (i >= 0) arr.splice(i, 1);
      } else {
        const i = arr.findIndex((r) => r.id === o.put.id);
        if (i >= 0) arr[i] = o.put;
        else arr.push(o.put);
      }
    }
  }

  async commit(ops, audits = [], { dataChange = true, raw = false } = {}) {
    const now = this.clock();
    if (!raw) {
      for (const o of ops) {
        if (!o.clear && WRITE_PERMISSION[o.store]) this.requirePerm(WRITE_PERMISSION[o.store]);
        if (o.store === "meta" && o.put && o.put.id === "keys") this.requirePerm("users");
      }
    }
    const all = [...ops];
    for (const a of audits) {
      all.push({
        store: "audit",
        put: {
          id: newId("L"),
          at: now,
          user: this.user,
          action: a.action,
          entity: a.entity,
          entityId: a.entityId,
          reason: a.reason || "",
          before: redact(a.before, a.entity) || null,
          after: redact(a.after, a.entity) || null,
        },
      });
    }
    if (dataChange) all.push({ store: "meta", put: { ...this.backupMeta, lastChangeAt: now } });
    // Clinical records are encrypted on their way to disk; memory keeps the plain copy.
    const disk = [];
    for (const o of all) {
      if (!raw && o.put && CLINICAL_STORES.includes(o.store)) {
        if (!this.dek) throw new PermissionError("Clinical records are locked.");
        const sealed = { ...metaOf(o.store, o.put), enc: await sealJSON(this.dek, o.put) };
        disk.push({ store: o.store, put: sealed });
        o.sealed = sealed;
      } else disk.push(o);
    }
    await this.adapter.write(disk);
    for (const o of all) {
      if (!CLINICAL_STORES.includes(o.store)) continue;
      const arr = this._sealed[o.store];
      if (o.clear) arr.length = 0;
      else if (o.put) {
        const rec = raw ? o.put : o.sealed;
        const i = arr.findIndex((r) => r.id === rec.id);
        if (i >= 0) arr[i] = rec;
        else arr.push(rec);
      }
    }
    this._apply(all.filter((o) => !LAZY_STORES.includes(o.store) && !(raw && CLINICAL_STORES.includes(o.store))));
    if (raw) await this._openClinical();
    this._ledger = null;
    this._emit();
  }

  // Records exactly as stored on disk (clinical stores encrypted) — for backups.
  diskData() {
    const out = {};
    for (const s of STORES) {
      if (LAZY_STORES.includes(s)) continue;
      out[s] = CLINICAL_STORES.includes(s) ? this._sealed[s] : this.data[s];
    }
    return out;
  }

  async saveSettings(patch) {
    await this.commit([{ store: "meta", put: { ...this.settings, ...patch } }], [], { dataChange: false });
  }

  // ------------------------------------------------------------ locations & rates

  validateCategories(categories) {
    req(Array.isArray(categories) && categories.length > 0, "At least one fee category is required.");
    const keys = new Set();
    for (const c of categories) {
      req(clean(c.key) && clean(c.label), "Every fee category needs a name.");
      req(!keys.has(c.key), `Duplicate fee category "${c.label}".`);
      keys.add(c.key);
      req(isAmount(c.feePaise), `Fee for "${c.label}" must be zero or more.`);
    }
    req(keys.has("new") && keys.has("followup"), "New-patient and follow-up fees are required.");
  }

  async saveLocation(input, rate, reason = "") {
    const now = this.clock();
    const name = clean(input.name);
    req(name, "Location name is required.");
    req(ARRANGEMENTS[input.arrangement], "Choose a payment arrangement.");
    req(input.arrangement === "direct" || input.payerId, "Choose the hospital that settles payments for this location.");
    if (input.payerId) req(this.get("payers", input.payerId), "Unknown hospital.");
    const dup = this.data.locations.find((l) => l.name.toLowerCase() === name.toLowerCase() && l.id !== input.id);
    req(!dup, `A location named "${name}" already exists.`);
    const before = input.id ? this.get("locations", input.id) : null;
    const loc = {
      id: input.id || newId("LOC"),
      name,
      nameHi: clean(input.nameHi),
      kind: input.kind || "other",
      payerId: input.arrangement === "direct" ? null : input.payerId,
      arrangement: input.arrangement,
      active: input.active !== false,
      sortOrder: input.sortOrder ?? (before ? before.sortOrder : this.data.locations.length),
      createdAt: before ? before.createdAt : now,
      updatedAt: now,
    };
    const ops = [{ store: "locations", put: loc }];
    const audits = [{ action: before ? "update" : "create", entity: "location", entityId: loc.id, before, after: loc, reason }];
    if (rate) {
      const r = this._buildRate({ ...rate, locationId: loc.id });
      ops.push({ store: "rates", put: r });
      audits.push({ action: "create", entity: "rate", entityId: r.id, after: r });
    } else {
      req(before, "Fees are required for a new location.");
    }
    await this.commit(ops, audits);
    return loc;
  }

  async setLocationActive(id, active) {
    const before = this.get("locations", id);
    req(before, "Unknown location.");
    const after = { ...before, active, updatedAt: this.clock() };
    await this.commit([{ store: "locations", put: after }], [{ action: active ? "activate" : "deactivate", entity: "location", entityId: id, before, after }]);
  }

  _buildRate(input) {
    req(this.get("locations", input.locationId) || input.locationId, "Unknown location.");
    req(isIsoDate(input.effectiveFrom), "Effective-from date is invalid.");
    this.validateCategories(input.categories);
    return {
      id: input.id || newId("R"),
      locationId: input.locationId,
      effectiveFrom: input.effectiveFrom,
      categories: input.categories.map((c) => ({ key: c.key, label: clean(c.label), feePaise: c.feePaise, isVisit: c.isVisit !== false })),
      note: clean(input.note),
      createdAt: this.clock(),
    };
  }

  // New fees from a date. Existing visits keep the fee they were recorded with.
  async addRate(input) {
    req(this.get("locations", input.locationId), "Unknown location.");
    const r = this._buildRate(input);
    await this.commit([{ store: "rates", put: r }], [{ action: "create", entity: "rate", entityId: r.id, after: r }]);
    return r;
  }

  async updateRate(id, input, reason) {
    const before = this.get("rates", id);
    req(before, "Unknown rate.");
    req(clean(reason), "Give a reason for changing a fee schedule.");
    const r = { ...this._buildRate({ ...before, ...input, id }), createdAt: before.createdAt };
    await this.commit([{ store: "rates", put: r }], [{ action: "update", entity: "rate", entityId: id, before, after: r, reason }]);
    return r;
  }

  currentRate(locationId, date = today()) {
    return rateFor(this.data.rates, locationId, date);
  }

  // --------------------------------------------------------- hospitals & agreements

  async savePayer(input, reason = "") {
    const name = clean(input.name);
    req(name, "Hospital name is required.");
    const dup = this.data.payers.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== input.id);
    req(!dup, `A hospital named "${name}" already exists.`);
    const before = input.id ? this.get("payers", input.id) : null;
    const p = { id: input.id || newId("H"), name, active: input.active !== false, createdAt: before ? before.createdAt : this.clock() };
    await this.commit([{ store: "payers", put: p }], [{ action: before ? "update" : "create", entity: "payer", entityId: p.id, before, after: p, reason }]);
    return p;
  }

  async saveAgreement(input, reason = "") {
    req(this.get("payers", input.payerId), "Choose a hospital.");
    req(AGREEMENT_TYPES[input.type], "Choose an agreement type.");
    req(isIsoDate(input.effectiveFrom), "Effective-from date is invalid.");
    req(FREQUENCIES[input.frequency || "monthly"], "Choose a settlement frequency.");
    const t = input.type;
    const needPct = ["pct", "max_min_pct", "min_plus_pct", "salary_plus_pct"].includes(t);
    const needSalary = ["fixed", "salary_plus_pct"].includes(t);
    const needMin = ["min", "max_min_pct", "min_plus_pct"].includes(t);
    if (needPct) {
      req(Number.isInteger(input.pctBp) && input.pctBp > 0 && input.pctBp <= 10000, "Revenue share must be between 0 and 100%.");
      req(REVENUE_BASES[input.base], "Choose what the percentage applies to.");
    }
    if (needSalary) req(isAmount(input.salaryPaise) && input.salaryPaise > 0, "Enter the fixed salary.");
    if (needMin) req(isAmount(input.minPaise) && input.minPaise > 0, "Enter the minimum guaranteed amount.");
    const dueAfterDays = Number(input.dueAfterDays ?? 10);
    req(Number.isInteger(dueAfterDays) && dueAfterDays >= 0 && dueAfterDays <= 120, "Due days must be 0–120.");
    const before = input.id ? this.get("agreements", input.id) : null;
    const a = {
      id: input.id || newId("AG"),
      payerId: input.payerId,
      effectiveFrom: input.effectiveFrom,
      type: t,
      pctBp: needPct ? input.pctBp : 0,
      base: needPct ? input.base : null,
      salaryPaise: needSalary ? input.salaryPaise : 0,
      minPaise: needMin ? input.minPaise : 0,
      frequency: input.frequency || "monthly",
      dueAfterDays,
      notes: clean(input.notes),
      createdAt: before ? before.createdAt : this.clock(),
    };
    await this.commit([{ store: "agreements", put: a }], [{ action: before ? "update" : "create", entity: "agreement", entityId: a.id, before, after: a, reason }]);
    return a;
  }

  // ------------------------------------------------------------------ sessions

  findDuplicateSessions(date, locationId, sessionName, exceptId) {
    const n = clean(sessionName).toLowerCase();
    return this.data.sessions.filter(
      (s) => !s.voided && s.id !== exceptId && s.date === date && s.locationId === locationId && s.sessionName.toLowerCase() === n,
    );
  }

  _collectorFor(loc, requested) {
    if (loc.arrangement === "direct") return "me";
    if (loc.arrangement === "hospital") return "hospital";
    return requested === "hospital" ? "hospital" : "me";
  }

  _newSession({ date, locationId, sessionName, mode, collector, remarks }) {
    const loc = this.get("locations", locationId);
    const now = this.clock();
    return {
      id: newSessionId(date, loc.name, sessionName),
      date,
      locationId,
      sessionName: clean(sessionName),
      mode,
      collector: this._collectorFor(loc, collector),
      summary: null,
      status: mode === "summary_recon" ? "needs_recon" : "open",
      recon: null,
      remarks: clean(remarks),
      voided: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Quick OPD summary: create or edit. Returns { needsConfirm, duplicates } when an
  // identical date/location/session already exists and allowDuplicate is not set.
  async saveSummarySession(input, { allowDuplicate = false, reason = "" } = {}) {
    req(isIsoDate(input.date), "Date is invalid.");
    const loc = this.get("locations", input.locationId);
    req(loc, "Choose a location.");
    req(clean(input.sessionName), "Choose a session.");
    req(["summary", "summary_recon"].includes(input.mode || "summary"), "Invalid session mode.");
    const before = input.id ? this.get("sessions", input.id) : null;
    req(!before || !before.voided, "This session was voided.");
    if (!before) req(loc.active, "This location is inactive.");
    const lines = (input.lines || []).map((l) => ({
      key: l.key,
      label: clean(l.label),
      count: Number(l.count || 0),
      feePaise: l.feePaise || 0,
      isVisit: l.isVisit !== false,
    }));
    for (const l of lines) {
      req(Number.isInteger(l.count) && l.count >= 0 && l.count <= 5000, `Patient count for "${l.label}" must be a whole number.`);
      req(isAmount(l.feePaise), `Fee for "${l.label}" must be zero or more.`);
    }
    const lineGross = sum(lines, (l) => l.count * l.feePaise);
    const override = input.grossOverridePaise ?? null;
    if (override !== null) req(isAmount(override), "Gross fees must be zero or more.");
    const gross = override !== null ? override : lineGross;
    const discount = input.discountPaise || 0;
    req(isAmount(discount), "Discounts must be zero or more.");
    req(discount <= gross, "Discounts cannot exceed gross fees.");
    const net = gross - discount;

    const collector = this._collectorFor(loc, input.collector);
    const col = input.collections || {};
    const colOps = [];
    let collected = 0;
    for (const m of Object.keys(METHODS)) {
      const v = col[m] || 0;
      req(isAmount(v), `${METHODS[m]} amount must be zero or more.`);
      collected += v;
    }
    if (collector === "hospital") req(collected === 0, "The hospital collects at this location: record its settlement instead of patient collections.");
    req(collected <= net, `Collections (${fmtINR(collected)}) exceed net fees (${fmtINR(net)}).`);

    if (!before && !allowDuplicate) {
      const duplicates = this.findDuplicateSessions(input.date, input.locationId, input.sessionName);
      if (duplicates.length) return { needsConfirm: true, duplicates };
    }

    const now = this.clock();
    let s;
    const audits = [];
    if (before) {
      req(before.summary, "This session has no summary to edit.");
      const moved = before.date !== input.date || before.locationId !== input.locationId;
      const hasVisits = this.data.visits.some((v) => v.sessionId === before.id && !v.voided);
      req(!(moved && hasVisits), "Move the individual visits before changing the date or location of this session.");
      s = { ...before, date: input.date, locationId: input.locationId, sessionName: clean(input.sessionName), collector, remarks: clean(input.remarks), updatedAt: now };
      if (hasVisits || input.mode === "summary_recon") s.mode = "summary_recon";
      else s.mode = input.mode || before.mode;
      if (s.mode === "summary_recon" && before.status === "reconciled") {
        s.status = "needs_recon";
        s.recon = null;
        audits.push({ action: "reopen", entity: "session", entityId: s.id, reason: "Summary edited after reconciliation" });
      }
      // Replace the previous summary collections (they are summary figures, not separate receipts).
      for (const p of this.data.payments.filter((p) => p.origin === "summary" && p.sessionId === before.id && !p.voided)) {
        colOps.push({ store: "payments", put: { ...p, voided: true, voidReason: "Summary edited", voidedAt: now } });
      }
    } else {
      s = this._newSession({ ...input, mode: input.mode || "summary" });
    }
    s.summary = { lines, grossOverridePaise: override, discountPaise: discount };
    if (s.mode === "summary_recon" && s.status !== "reconciled") s.status = "needs_recon";

    for (const m of Object.keys(METHODS)) {
      const v = col[m] || 0;
      if (!v) continue;
      const p = {
        id: newId("P"), date: s.date, kind: "payment", payerType: "patient", payerId: null, locationId: s.locationId, method: m,
        amountPaise: v, reference: clean((input.references || {})[m]), origin: "summary", sessionId: s.id, advance: false, notes: "", voided: false, createdAt: now,
      };
      colOps.push({ store: "payments", put: p }, { store: "allocations", put: { id: newId("AL"), paymentId: p.id, targetType: "session", targetId: s.id, amountPaise: v } });
    }
    audits.unshift({ action: before ? "update" : "create", entity: "session", entityId: s.id, before, after: s, reason });
    await this.commit([{ store: "sessions", put: s }, ...colOps], audits);
    return { session: s };
  }

  async updateSessionInfo(id, patch, reason = "") {
    const before = this.get("sessions", id);
    req(before && !before.voided, "Unknown session.");
    const after = { ...before, remarks: clean(patch.remarks ?? before.remarks), sessionName: clean(patch.sessionName ?? before.sessionName), updatedAt: this.clock() };
    if (patch.mode) {
      req(["summary", "individual", "summary_recon"].includes(patch.mode), "Invalid mode.");
      const hasVisits = this.data.visits.some((v) => v.sessionId === id && !v.voided);
      if (patch.mode === "summary") req(!hasVisits, "This session has individual visits; use summary + reconciliation.");
      if (patch.mode !== "individual") req(before.summary, "Add a summary first.");
      after.mode = patch.mode;
      after.status = patch.mode === "summary_recon" && before.status !== "reconciled" ? "needs_recon" : before.status === "needs_recon" ? "open" : before.status;
    }
    await this.commit([{ store: "sessions", put: after }], [{ action: "update", entity: "session", entityId: id, before, after, reason }]);
    return after;
  }

  // Find (or prepare) the session that an individual visit belongs to.
  _sessionForVisit(input, ops, audits) {
    if (input.sessionId) {
      const s = this.get("sessions", input.sessionId);
      req(s && !s.voided, "Unknown session.");
      return s;
    }
    req(isIsoDate(input.date), "Date is invalid.");
    const loc = this.get("locations", input.locationId);
    req(loc, "Choose a location.");
    req(loc.active, "This location is inactive.");
    req(clean(input.sessionName), "Choose a session.");
    const existing = this.findDuplicateSessions(input.date, input.locationId, input.sessionName);
    if (existing.length) return existing.sort((a, b) => b.createdAt - a.createdAt)[0];
    const s = this._newSession({ date: input.date, locationId: input.locationId, sessionName: input.sessionName, mode: "individual", collector: input.collector });
    ops.push({ store: "sessions", put: s });
    audits.push({ action: "create", entity: "session", entityId: s.id, after: s, reason: "Created for individual entry" });
    return s;
  }

  // Adding/changing visits of a summary session moves it to (re)reconciliation.
  _touchSession(s, ops, audits, now) {
    const cur = ops.find((o) => o.store === "sessions" && o.put.id === s.id);
    const base = cur ? cur.put : s;
    let next = null;
    if (base.mode === "summary") next = { ...base, mode: "summary_recon", status: "needs_recon", updatedAt: now };
    else if (base.mode === "summary_recon" && base.status === "reconciled") {
      next = { ...base, status: "needs_recon", recon: null, updatedAt: now };
      audits.push({ action: "reopen", entity: "session", entityId: s.id, before: base, after: next, reason: "Individual records changed after reconciliation" });
    }
    if (next) {
      if (cur) cur.put = next;
      else ops.push({ store: "sessions", put: next });
    }
  }

  async addVisit(input, opts = {}) {
    const r = this._visitOps(input, opts);
    if (r.needsConfirm) return r;
    await this.commit(r.ops, r.audits);
    return { visit: r.visit, session: this.get("sessions", r.session.id) };
  }

  // Builds (but does not commit) the writes for a new visit, so that other operations
  // (e.g. a clinical encounter with billing) can commit them in the same transaction.
  _visitOps(input, { allowDuplicate = false } = {}) {
    const ops = [];
    const audits = [];
    const now = this.clock();
    const s = this._sessionForVisit(input, ops, audits);
    const rate = rateFor(this.data.rates, s.locationId, s.date);
    req(rate, "No fee schedule is in force for this location on this date. Add fees in Locations.");
    const cat = rate.categories.find((c) => c.key === input.category);
    req(cat, "Choose the visit type.");
    const feePaise = input.feePaise ?? cat.feePaise;
    req(isAmount(feePaise), "Fee must be zero or more.");
    const overridden = feePaise !== cat.feePaise;
    if (overridden) req(clean(input.overrideReason), "Give a reason for changing the standard fee.");
    const discount = input.discountPaise || 0;
    req(isAmount(discount), "Discount must be zero or more.");
    req(discount <= feePaise, "Discount cannot exceed the fee.");
    if (discount) req(clean(input.discountReason) || input.discountType === "waiver", "Give a reason for the discount.");
    const net = feePaise - discount;
    const pay = input.payment && input.payment.amountPaise ? input.payment : null;
    if (pay) {
      req(s.collector === "me", "The hospital collects fees at this session; patient payments are not recorded here.");
      req(isAmount(pay.amountPaise), "Amount received must be zero or more.");
      req(pay.amountPaise <= net, `Amount received (${fmtINR(pay.amountPaise)}) exceeds the net fee (${fmtINR(net)}).`);
      req(METHODS[pay.method], "Choose the payment method.");
      const pd = pay.date || s.date;
      req(isIsoDate(pd) && pd >= s.date, "Payment date cannot be before the consultation date.");
    }
    const patientId = clean(input.patientId);
    if (input.patientRecordId) req(this.get("patients", input.patientRecordId), "Unknown patient record.");
    if (patientId && !allowDuplicate) {
      const dups = this.data.visits.filter((v) => !v.voided && v.sessionId === s.id && v.patientId && v.patientId.toLowerCase() === patientId.toLowerCase());
      if (dups.length) return { needsConfirm: true, duplicates: dups };
    }

    const v = {
      id: newVisitId(s.date),
      sessionId: s.id,
      date: s.date,
      locationId: s.locationId,
      patientId,
      patientName: clean(input.patientName),
      patientRecordId: input.patientRecordId || null,
      category: cat.key,
      categoryLabel: cat.label,
      isVisit: cat.isVisit !== false,
      standardFeePaise: cat.feePaise,
      feePaise,
      overrideReason: overridden ? clean(input.overrideReason) : "",
      remarks: clean(input.remarks),
      cancelled: false,
      voided: false,
      createdAt: now,
      updatedAt: now,
    };
    ops.push({ store: "visits", put: v });
    audits.push({ action: "create", entity: "visit", entityId: v.id, after: v });
    if (discount) {
      const a = { id: newId("ADJ"), date: s.date, targetType: "visit", targetId: v.id, type: input.discountType === "waiver" ? "waiver" : "discount", amountPaise: discount, reason: clean(input.discountReason), voided: false, createdAt: now };
      ops.push({ store: "adjustments", put: a });
      audits.push({ action: "create", entity: "adjustment", entityId: a.id, after: a });
    }
    if (pay) {
      const p = {
        id: newId("P"), date: pay.date || s.date, kind: "payment", payerType: "patient", payerId: null, locationId: s.locationId, method: pay.method,
        amountPaise: pay.amountPaise, reference: clean(pay.reference), origin: "entry", sessionId: s.id, advance: false, notes: "", voided: false, createdAt: now,
      };
      ops.push({ store: "payments", put: p }, { store: "allocations", put: { id: newId("AL"), paymentId: p.id, targetType: "visit", targetId: v.id, amountPaise: pay.amountPaise } });
      audits.push({ action: "create", entity: "payment", entityId: p.id, after: p });
    }
    this._touchSession(s, ops, audits, now);
    return { ops, audits, visit: v, session: s };
  }

  // Link a financial visit to a patient master record. Changes no money.
  async linkVisitToPatient(visitId, patientRecordId) {
    const before = this.get("visits", visitId);
    req(before && !before.voided, "Unknown visit.");
    if (patientRecordId) req(this.get("patients", patientRecordId), "Unknown patient record.");
    const after = { ...before, patientRecordId: patientRecordId || null, updatedAt: this.clock() };
    await this.commit([{ store: "visits", put: after }], [{ action: patientRecordId ? "link-patient" : "unlink-patient", entity: "visit", entityId: visitId, before, after }]);
    return after;
  }

  async updateVisit(id, patch, reason) {
    const before = this.get("visits", id);
    req(before && !before.voided, "Unknown visit.");
    req(clean(reason), "Give a reason for the correction.");
    const s = this.get("sessions", before.sessionId);
    const after = { ...before, updatedAt: this.clock() };
    if (patch.patientId !== undefined) after.patientId = clean(patch.patientId);
    if (patch.patientName !== undefined) after.patientName = clean(patch.patientName);
    if (patch.remarks !== undefined) after.remarks = clean(patch.remarks);
    if (patch.category !== undefined && patch.category !== before.category) {
      const rate = rateFor(this.data.rates, s.locationId, s.date);
      const cat = rate && rate.categories.find((c) => c.key === patch.category);
      req(cat, "Unknown visit type.");
      Object.assign(after, { category: cat.key, categoryLabel: cat.label, isVisit: cat.isVisit !== false, standardFeePaise: cat.feePaise });
      if (patch.feePaise === undefined) after.feePaise = cat.feePaise;
    }
    if (patch.feePaise !== undefined) {
      req(isAmount(patch.feePaise), "Fee must be zero or more.");
      after.feePaise = patch.feePaise;
    }
    after.overrideReason = after.feePaise !== after.standardFeePaise ? clean(patch.overrideReason) || before.overrideReason || reason : "";
    const f = this.ledger.visitFin.get(id);
    const newNet = after.feePaise - f.discount + f.correction;
    req(newNet >= 0, "Discounts on this visit exceed the new fee: void a discount first.");
    req(newNet >= f.paid, `Payments already received (${fmtINR(f.paid)}) exceed the new net fee: record a refund first.`);
    const ops = [{ store: "visits", put: after }];
    const audits = [{ action: "update", entity: "visit", entityId: id, before, after, reason }];
    this._touchSession(s, ops, audits, after.updatedAt);
    await this.commit(ops, audits);
    return after;
  }

  // Cancellation: the visit stops counting as a consultation. Payments stay as received
  // money until refunded.
  async cancelVisit(id, reason) {
    const before = this.get("visits", id);
    req(before && !before.voided && !before.cancelled, "Unknown visit.");
    req(clean(reason), "Give a reason for the cancellation.");
    const now = this.clock();
    const f = this.ledger.visitFin.get(id);
    const after = { ...before, cancelled: true, updatedAt: now };
    const adj = { id: newId("ADJ"), date: today(), targetType: "visit", targetId: id, type: "cancellation", amountPaise: f.net, reason: clean(reason), voided: false, createdAt: now };
    const ops = [{ store: "visits", put: after }, { store: "adjustments", put: adj }];
    const audits = [{ action: "cancel", entity: "visit", entityId: id, before, after, reason }];
    this._touchSession(this.get("sessions", before.sessionId), ops, audits, now);
    await this.commit(ops, audits);
    return after;
  }

  // Void = entered by mistake. Allowed only when no money is attached.
  async voidVisit(id, reason) {
    const before = this.get("visits", id);
    req(before && !before.voided, "Unknown visit.");
    req(clean(reason), "Give a reason.");
    const f = this.ledger.visitFin.get(id);
    req(!f || f.paid === 0, "This visit has payments. Void the payment or record a refund first.");
    const now = this.clock();
    const after = { ...before, voided: true, voidReason: clean(reason), updatedAt: now };
    const ops = [{ store: "visits", put: after }];
    const audits = [{ action: "void", entity: "visit", entityId: id, before, after, reason }];
    this._touchSession(this.get("sessions", before.sessionId), ops, audits, now);
    await this.commit(ops, audits);
  }

  async voidSession(id, reason) {
    const before = this.get("sessions", id);
    req(before && !before.voided, "Unknown session.");
    req(clean(reason), "Give a reason.");
    const vs = this.data.visits.filter((v) => v.sessionId === id && !v.voided);
    req(vs.length === 0, "Void the individual visits of this session first.");
    const now = this.clock();
    const other = this.data.payments.filter((p) => p.sessionId === id && !p.voided && p.origin !== "summary");
    req(other.length === 0, "This session has later payments. Void them first.");
    const ops = [{ store: "sessions", put: { ...before, voided: true, voidReason: clean(reason), updatedAt: now } }];
    for (const p of this.data.payments.filter((p) => p.sessionId === id && !p.voided)) ops.push({ store: "payments", put: { ...p, voided: true, voidReason: "Session voided", voidedAt: now } });
    await this.commit(ops, [{ action: "void", entity: "session", entityId: id, before, reason }]);
  }

  // ------------------------------------------------------------- adjustments

  async addAdjustment(input) {
    req(["visit", "session", "settlement"].includes(input.targetType), "Invalid adjustment target.");
    req(clean(input.reason), "Give a reason for the adjustment.");
    const type = input.type;
    const amt = input.amountPaise;
    req(isPaise(amt) && amt !== 0, "Enter the adjustment amount.");
    const now = this.clock();
    const ops = [];
    const audits = [];
    if (input.targetType === "settlement") {
      req(type === "settlement", "Invalid adjustment type.");
      req(this.get("settlements", input.targetId), "Unknown settlement.");
    } else {
      req(["discount", "waiver", "correction"].includes(type), "Invalid adjustment type.");
      if (type !== "correction") req(amt > 0, "Discount must be more than zero.");
      let net, paid, s;
      if (input.targetType === "visit") {
        const v = this.get("visits", input.targetId);
        req(v && !v.voided && !v.cancelled, "Unknown visit.");
        const f = this.ledger.visitFin.get(v.id);
        net = f.net;
        paid = f.paid;
        s = this.get("sessions", v.sessionId);
      } else {
        s = this.get("sessions", input.targetId);
        req(s && !s.voided && s.summary, "Session adjustments apply to summary figures only.");
        const f = this.ledger.sessionFin.get(s.id).summary;
        net = f.net;
        paid = f.paid;
      }
      const delta = type === "correction" ? amt : -amt;
      req(net + delta >= 0, "The adjustment would make the fee negative.");
      req(net + delta >= paid || s.collector === "hospital", `Payments already received (${fmtINR(paid)}) would exceed the fee: record a refund first.`);
      if (input.targetType === "visit") this._touchSession(s, ops, audits, now);
    }
    const a = { id: newId("ADJ"), date: input.date || today(), targetType: input.targetType, targetId: input.targetId, type, amountPaise: amt, reason: clean(input.reason), voided: false, createdAt: now };
    ops.unshift({ store: "adjustments", put: a });
    audits.unshift({ action: "create", entity: "adjustment", entityId: a.id, after: a, reason: a.reason });
    await this.commit(ops, audits);
    return a;
  }

  async voidAdjustment(id, reason) {
    const before = this.get("adjustments", id);
    req(before && !before.voided, "Unknown adjustment.");
    req(before.type !== "cancellation", "Cancellations cannot be voided.");
    req(clean(reason), "Give a reason.");
    const after = { ...before, voided: true, voidReason: clean(reason) };
    await this.commit([{ store: "adjustments", put: after }], [{ action: "void", entity: "adjustment", entityId: id, before, after, reason }]);
  }

  // ----------------------------------------------------------------- payments

  _targetOutstanding(targetType, targetId) {
    const L = this.ledger;
    if (targetType === "visit") {
      const v = this.get("visits", targetId);
      req(v && !v.voided, "Unknown visit.");
      const s = this.get("sessions", v.sessionId);
      return { s, outstanding: L.visitFin.get(v.id).outstanding, paid: L.visitFin.get(v.id).paid };
    }
    const s = this.get("sessions", targetId);
    req(s && !s.voided, "Unknown session.");
    const f = L.sessionFin.get(s.id).eff;
    return { s, outstanding: f.outstanding, paid: f.paid };
  }

  // Patient payment allocated to one or more visits/sessions. Allocations cannot exceed
  // what is outstanding; any remainder must be explicitly marked as an advance.
  async recordPatientPayment(input) {
    req(isIsoDate(input.date), "Payment date is invalid.");
    req(METHODS[input.method], "Choose the payment method.");
    req(isAmount(input.amountPaise) && input.amountPaise > 0, "Enter the amount received.");
    const allocations = (input.allocations || []).filter((a) => a.amountPaise > 0);
    let allocated = 0;
    let locationId = input.locationId || null;
    const seen = new Set();
    for (const a of allocations) {
      req(isAmount(a.amountPaise), "Allocation amounts must be positive.");
      req(!seen.has(a.targetType + a.targetId), "The same visit is listed twice.");
      seen.add(a.targetType + a.targetId);
      const t = this._targetOutstanding(a.targetType, a.targetId);
      req(t.s.collector === "me", "The hospital collects fees at that session.");
      req(input.date >= t.s.date, "Payment date cannot be before the consultation date.");
      req(a.amountPaise <= t.outstanding, `Allocation of ${fmtINR(a.amountPaise)} exceeds the outstanding ${fmtINR(Math.max(0, t.outstanding))}.`);
      allocated += a.amountPaise;
      locationId = locationId || t.s.locationId;
    }
    req(allocated <= input.amountPaise, "Allocations exceed the payment amount.");
    if (allocated < input.amountPaise) req(input.advance, `${fmtINR(input.amountPaise - allocated)} is not allocated to any visit. Allocate it or mark it as an advance.`);
    req(locationId && this.get("locations", locationId), "Choose the location.");
    const now = this.clock();
    const p = {
      id: newId("P"), date: input.date, kind: "payment", payerType: "patient", payerId: null, locationId, method: input.method, amountPaise: input.amountPaise,
      reference: clean(input.reference), origin: "entry", sessionId: allocations.length === 1 ? this._targetOutstanding(allocations[0].targetType, allocations[0].targetId).s.id : null,
      advance: !!input.advance && allocated < input.amountPaise, notes: clean(input.notes), voided: false, createdAt: now,
    };
    const ops = [{ store: "payments", put: p }];
    for (const a of allocations) ops.push({ store: "allocations", put: { id: newId("AL"), paymentId: p.id, targetType: a.targetType, targetId: a.targetId, amountPaise: a.amountPaise } });
    await this.commit(ops, [{ action: "create", entity: "payment", entityId: p.id, after: p }]);
    return p;
  }

  async recordRefund(input) {
    req(isIsoDate(input.date), "Refund date is invalid.");
    req(METHODS[input.method], "Choose the refund method.");
    req(isAmount(input.amountPaise) && input.amountPaise > 0, "Enter the refund amount.");
    req(clean(input.reason), "Give a reason for the refund.");
    const t = this._targetOutstanding(input.targetType, input.targetId);
    req(input.amountPaise <= t.paid, `Refund exceeds the ${fmtINR(t.paid)} received.`);
    const now = this.clock();
    const p = {
      id: newId("P"), date: input.date, kind: "refund", payerType: "patient", payerId: null, locationId: t.s.locationId, method: input.method, amountPaise: input.amountPaise,
      reference: clean(input.reference), origin: "entry", sessionId: t.s.id, advance: false, notes: clean(input.reason), voided: false, createdAt: now,
    };
    await this.commit(
      [{ store: "payments", put: p }, { store: "allocations", put: { id: newId("AL"), paymentId: p.id, targetType: input.targetType, targetId: input.targetId, amountPaise: input.amountPaise } }],
      [{ action: "refund", entity: "payment", entityId: p.id, after: p, reason: input.reason }],
    );
    return p;
  }

  // Reversal of a payment entered by mistake. The record stays, marked void.
  async voidPayment(id, reason) {
    const before = this.get("payments", id);
    req(before && !before.voided, "Unknown payment.");
    req(before.origin !== "summary", "Summary collections change when the session summary is edited.");
    req(clean(reason), "Give a reason.");
    const after = { ...before, voided: true, voidReason: clean(reason), voidedAt: this.clock() };
    await this.commit([{ store: "payments", put: after }], [{ action: "void", entity: "payment", entityId: id, before, after, reason }]);
  }

  // ------------------------------------------------------------ reconciliation

  async reconcileSession(id, { source = "individual", note = "" } = {}) {
    const s = this.get("sessions", id);
    req(s && !s.voided, "Unknown session.");
    const f = this.ledger.sessionFin.get(id);
    req(f.recon, "This session has no summary/individual comparison.");
    req(["individual", "summary"].includes(source), "Choose which records are correct.");
    req(source === "summary" || f.visitCount > 0, "There are no individual records to use.");
    if (!f.recon.matches) req(clean(note), "Record the reason for the discrepancy.");
    const after = { ...s, status: "reconciled", recon: { source, note: clean(note), at: this.clock(), by: this.user, items: f.recon.items }, updatedAt: this.clock() };
    await this.commit([{ store: "sessions", put: after }], [{ action: "reconcile", entity: "session", entityId: id, before: s, after, reason: note }]);
    return after;
  }

  async reopenSession(id, reason) {
    const s = this.get("sessions", id);
    req(s && s.status === "reconciled", "This session is not reconciled.");
    req(clean(reason), "Give a reason for reopening.");
    const after = { ...s, status: "needs_recon", recon: null, updatedAt: this.clock() };
    await this.commit([{ store: "sessions", put: after }], [{ action: "reopen", entity: "session", entityId: id, before: s, after, reason }]);
    return after;
  }

  // --------------------------------------------------------------- settlements

  async saveSettlement(input, reason = "") {
    const payer = this.get("payers", input.payerId);
    req(payer, "Choose a hospital.");
    req(isIsoDate(input.periodStart) && isIsoDate(input.periodEnd) && input.periodStart <= input.periodEnd, "Settlement period is invalid.");
    if (input.dueDate) req(isIsoDate(input.dueDate), "Due date is invalid.");
    for (const k of ["reportedBasePaise", "manualAmountPaise"]) if (input[k] !== null && input[k] !== undefined) req(isAmount(input[k]), "Amounts must be zero or more.");
    const before = input.id ? this.get("settlements", input.id) : null;
    req(!before || !before.finalized, "Unlock the finalised settlement before editing it.");
    const overlap = this.data.settlements.find(
      (x) => !x.voided && x.id !== input.id && x.payerId === input.payerId && x.periodStart <= input.periodEnd && input.periodStart <= x.periodEnd,
    );
    req(!overlap, "A settlement for this hospital already covers part of this period.");
    const st = {
      id: input.id || newId("ST"),
      payerId: input.payerId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      dueDate: input.dueDate || null,
      reportedBasePaise: input.reportedBasePaise ?? null,
      manualAmountPaise: input.manualAmountPaise ?? null,
      notes: clean(input.notes),
      finalized: null,
      voided: false,
      createdAt: before ? before.createdAt : this.clock(),
    };
    await this.commit([{ store: "settlements", put: st }], [{ action: before ? "update" : "create", entity: "settlement", entityId: st.id, before, after: st, reason }]);
    return st;
  }

  settlementView(id, asOf = today()) {
    return computeSettlement(this.data, this.ledger, this.get("settlements", id), asOf);
  }

  // Lock the calculated amount so later edits to visits do not silently change it.
  async finalizeSettlement(id) {
    const before = this.get("settlements", id);
    req(before && !before.voided && !before.finalized, "Unknown or already finalised settlement.");
    const v = this.settlementView(id);
    const { adjustments, total, ...calc } = v.live;
    const after = { ...before, finalized: { at: this.clock(), by: this.user, calc } };
    await this.commit([{ store: "settlements", put: after }], [{ action: "finalize", entity: "settlement", entityId: id, before, after }]);
    return after;
  }

  async unfinalizeSettlement(id, reason) {
    const before = this.get("settlements", id);
    req(before && before.finalized, "This settlement is not finalised.");
    req(clean(reason), "Give a reason.");
    const after = { ...before, finalized: null };
    await this.commit([{ store: "settlements", put: after }], [{ action: "unlock", entity: "settlement", entityId: id, before, after, reason }]);
  }

  async voidSettlement(id, reason) {
    const before = this.get("settlements", id);
    req(before && !before.voided, "Unknown settlement.");
    req(clean(reason), "Give a reason.");
    req(this.settlementView(id).paid === 0, "Payments are recorded against this settlement. Void them first.");
    const after = { ...before, voided: true, voidReason: clean(reason) };
    await this.commit([{ store: "settlements", put: after }], [{ action: "void", entity: "settlement", entityId: id, before, after, reason }]);
  }

  // Payment from a hospital reduces that settlement's balance only: it creates no
  // visits and no consultation revenue.
  async recordHospitalPayment(input) {
    const st = this.get("settlements", input.settlementId);
    req(st && !st.voided, "Choose the settlement period.");
    req(isIsoDate(input.date), "Payment date is invalid.");
    req(METHODS[input.method], "Choose the payment method.");
    req(isAmount(input.amountPaise) && input.amountPaise > 0, "Enter the amount received.");
    const v = this.settlementView(st.id);
    const alloc = Math.min(input.amountPaise, Math.max(0, v.balance));
    if (alloc < input.amountPaise) req(input.advance, `Payment exceeds the balance due (${fmtINR(Math.max(0, v.balance))}). Mark the excess as an advance or add a settlement adjustment first.`);
    const now = this.clock();
    const p = {
      id: newId("P"), date: input.date, kind: "payment", payerType: "hospital", payerId: st.payerId, locationId: null, method: input.method, amountPaise: input.amountPaise,
      reference: clean(input.reference), origin: "entry", sessionId: null, advance: alloc < input.amountPaise, notes: clean(input.notes), voided: false, createdAt: now,
    };
    const ops = [{ store: "payments", put: p }];
    if (alloc > 0) ops.push({ store: "allocations", put: { id: newId("AL"), paymentId: p.id, targetType: "settlement", targetId: st.id, amountPaise: alloc } });
    await this.commit(ops, [{ action: "create", entity: "payment", entityId: p.id, after: p }]);
    return p;
  }

  // ------------------------------------------------------------------- helpers

  locationsSorted({ includeInactive = false } = {}) {
    return this.data.locations.filter((l) => includeInactive || l.active).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  }

  counts() {
    const out = {};
    for (const s of DATA_STORES) out[s] = this.data[s].length;
    return out;
  }

  // Replace every store (restore). Caller validates the backup first.
  // Replace every store (restore). Caller validates the backup first. Records are
  // written exactly as in the backup (clinical ones stay encrypted).
  async replaceAll(stores, auditEntry) {
    const ops = [];
    for (const s of DATA_STORES) {
      ops.push({ store: s, clear: true });
      for (const r of stores[s] || []) ops.push({ store: s, put: r });
    }
    await this.commit(ops, auditEntry ? [auditEntry] : [], { dataChange: false, raw: true });
  }

  // Bulk insert of already-built records (old-tracker import, demo data).
  async importRecords(records, reason) {
    const ops = [];
    for (const s of DATA_STORES) for (const r of records[s] || []) ops.push({ store: s, put: r });
    await this.commit(ops, [{ action: "import", entity: "database", entityId: "bulk", reason, after: { counts: Object.fromEntries(DATA_STORES.map((s) => [s, (records[s] || []).length])) } }]);
  }

  payerName(id) {
    const p = this.get("payers", id);
    return p ? p.name : "";
  }
  locationName(id) {
    const l = this.get("locations", id);
    return l ? l.name : "(deleted location)";
  }
}

export function metaOf(store, rec) {
  const m = { id: rec.id };
  for (const k of ["createdAt", "updatedAt", ...(CLINICAL_META[store] || [])]) if (rec[k] !== undefined) m[k] = rec[k];
  return m;
}

export { mapBy, req, clean };
