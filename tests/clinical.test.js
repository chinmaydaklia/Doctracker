// Clinical records upgrade: migration safety, financial isolation, history, access control.
import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { setup, lines, R } from "./helpers.js";
import { Store, PermissionError } from "../js/store.js";
import "../js/clinical-store.js";
import { openIndexedDB, memoryAdapter } from "../js/db.js";
import { setupFirstDoctor, signIn, signOut, addUser, recoverWithCode } from "../js/auth.js";
import { activityTotals, collectionTotals, computeSettlement } from "../js/calc.js";
import { dailyReport, monthlyReport, locationReport, paymentReport } from "../js/reports.js";
import { buildBackup, verifyBackup, restoreBackup } from "../js/backup.js";
import { FINANCIAL_STORES, DB_SCHEMA_VERSION } from "../js/model.js";
import { checkVital, problemList, composeNote, noteToText, findPatientMatches, bmi } from "../js/clinical.js";

const IT = 1000; // fast key derivation for tests
const D = "2026-03-10";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 1, 2, 3]);

async function clinicalSetup() {
  const s = await setup();
  const { recoveryCode, user } = await setupFirstDoctor(s.store, { name: "Dr Daklia", username: "doctor", password: "correct horse 1", iterations: IT });
  const { patient } = await s.store.registerPatient({ name: "Ramesh Kumar", ageYears: 54, sex: "male", mobile: "9876543210" });
  return { ...s, doctor: user, recoveryCode, patient };
}

function financeSnapshot(store) {
  const L = store.ledger;
  return {
    act: activityTotals(L, {}),
    col: collectionTotals(L, {}),
    visits: store.data.visits.length,
    payments: store.data.payments.length,
    allocations: store.data.allocations.length,
    adjustments: store.data.adjustments.length,
    sessions: store.data.sessions.length,
  };
}

test("migration: schema 1 database upgrades with financial reports unchanged and a pre-upgrade copy", async () => {
  // Build realistic financial data, then write it into a schema-1 database.
  const { store, clinic, ward, hosp } = await setup();
  await store.saveSummarySession({ date: D, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, D, { new: 4, followup: 3 }), collections: { cash: R(1000) } });
  const { visit } = await store.addVisit({ date: D, locationId: clinic.id, sessionName: "evening", category: "new", payment: { amountPaise: R(200), method: "upi" } });
  await store.recordPatientPayment({ date: "2026-04-02", method: "cash", amountPaise: R(100), allocations: [{ targetType: "visit", targetId: visit.id, amountPaise: R(100) }] });
  await store.saveSummarySession({ date: D, locationId: ward.id, sessionName: "morning", lines: lines(store, ward.id, D, { new: 20 }) });
  await store.saveAgreement({ payerId: hosp.id, effectiveFrom: "2026-01-01", type: "max_min_pct", minPaise: R(2000), pctBp: 3000, base: "gross" });
  const st = await store.saveSettlement({ payerId: hosp.id, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
  const before = {
    daily: dailyReport(store.ledger, {}).totals,
    monthly: monthlyReport(store.ledger, { from: "2026-03-01", to: "2026-04-30" }, "2026-04-30").rows,
    location: locationReport(store.ledger, {}).rows,
    payments: paymentReport(store.ledger, {}, () => "").totals,
    settlement: computeSettlement(store.data, store.ledger, st, "2026-04-30").calc.total,
  };

  const name = "migrate-" + Math.random();
  const v1 = await new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => [...FINANCIAL_STORES, "snapshots"].forEach((s) => r.result.createObjectStore(s, { keyPath: "id" }));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res) => {
    const tx = v1.transaction(FINANCIAL_STORES, "readwrite");
    for (const s of FINANCIAL_STORES) for (const rec of store.data[s]) tx.objectStore(s).put(rec);
    tx.oncomplete = res;
  });
  v1.close();

  const adapter = await openIndexedDB(name);
  assert.deepEqual([adapter.migration.from, adapter.migration.to], [1, DB_SCHEMA_VERSION]);
  const snap = await adapter.get("snapshots", adapter.migration.snapshotId);
  assert.equal(snap.stores.visits.length, store.data.visits.length, "pre-upgrade copy holds the old records");
  const up = await Store.open(adapter);
  for (const s of FINANCIAL_STORES.filter((x) => x !== "meta")) assert.deepEqual(up.data[s].length, store.data[s].length, s);
  assert.deepEqual(dailyReport(up.ledger, {}).totals, before.daily);
  assert.deepEqual(monthlyReport(up.ledger, { from: "2026-03-01", to: "2026-04-30" }, "2026-04-30").rows, before.monthly);
  assert.deepEqual(locationReport(up.ledger, {}).rows, before.location);
  assert.deepEqual(paymentReport(up.ledger, {}, () => "").totals, before.payments);
  assert.equal(computeSettlement(up.data, up.ledger, up.get("settlements", st.id), "2026-04-30").calc.total, before.settlement);
  adapter.close();
});

test("a clinical encounter never duplicates a financial visit or charge", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const { visit } = await store.addVisit({ date: D, locationId: clinic.id, sessionName: "morning", category: "new", payment: { amountPaise: R(300), method: "cash" } });
  const f0 = financeSnapshot(store);

  const e1 = await store.createEncounter({ patientId: patient.id, date: D, billing: { mode: "link", visitId: visit.id } });
  assert.equal(e1.visitId, visit.id);
  await store.updateEncounter(e1.id, { complaints: [{ text: "Fever", duration: "3 days" }] });
  await store.addVitals(e1.id, [{ type: "bp", values: { systolic: 130, diastolic: 84 } }, { type: "pulse", value: 88 }]);
  const dx = await store.saveDiagnosis({ encounterId: e1.id, kind: "primary", name: "Viral fever", certainty: "provisional" });
  await store.saveDiagnosis({ ...dx, certainty: "confirmed" }); // updating a diagnosis
  const inv = await store.saveInvestigation({ patientId: patient.id, encounterId: e1.id, name: "Haemoglobin", category: "cbc", value: "12.1", unit: "g/dL" });
  await store.attachFile({ patientId: patient.id, encounterId: e1.id, investigationId: inv.id, name: "cbc.pdf", bytes: PDF });
  const rx = await store.savePrescription({ encounterId: e1.id, items: [{ drug: "Paracetamol", strength: "650 mg", dose: "1 tab", frequency: "TDS", duration: "3 days" }] });
  await store.approvePrescription(rx.id);
  await store.finalizeEncounter(e1.id);

  const f1 = financeSnapshot(store);
  assert.deepEqual({ ...f1, visits: f1.visits }, { ...f0, visits: f0.visits }, "notes, diagnosis, reports and prescriptions created no financial record");
  assert.equal(store.get("visits", visit.id).patientRecordId, patient.id, "visit now linked to the patient record");
  await assert.rejects(store.createEncounter({ patientId: patient.id, date: D, billing: { mode: "link", visitId: visit.id } }), /already has a clinical record/);

  // Explicit billing creates exactly one visit, atomically with the encounter.
  const e2 = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, sessionName: "evening", billing: { mode: "new", category: "followup" } });
  const f2 = financeSnapshot(store);
  assert.equal(f2.visits, f1.visits + 1);
  assert.equal(f2.act.visits, f1.act.visits + 1);
  assert.equal(f2.act.gross, f1.act.gross + R(150));
  assert.equal(store.get("visits", e2.visitId).patientRecordId, patient.id);
  // No billing: no financial effect at all.
  await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, type: "ward", billing: { mode: "none" } });
  assert.deepEqual(financeSnapshot(store), f2);
});

test("multiple encounters for one patient, including the same day, keep separate histories", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const a = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  const b = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, type: "followup" });
  const c = await store.createEncounter({ patientId: patient.id, date: "2026-04-10", locationId: clinic.id });
  await store.addVitals(a.id, [{ type: "weight", value: 70 }]);
  await store.addVitals(c.id, [{ type: "weight", value: 68 }]);
  const rec = store.patientRecord(patient.id);
  assert.equal(rec.encounters.length, 3);
  assert.deepEqual(store._related(a.id).vitals.map((v) => v.value), [70]);
  assert.deepEqual(store._related(b.id).vitals, []);
  assert.deepEqual(store._related(c.id).vitals.map((v) => v.value), [68]);
});

test("vitals are validated, flagged, append-only and never overwritten", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  await assert.rejects(store.addVitals(e.id, [{ type: "bp", values: { systolic: 80, diastolic: 120 } }]), /Systolic must be higher/);
  await assert.rejects(store.addVitals(e.id, [{ type: "temp", value: 101 }]), /looks like °F/);
  await assert.rejects(store.addVitals(e.id, [{ type: "spo2", value: 104 }]), /possible range/);
  assert.equal(store.data.vitals.length, 0, "nothing saved when a value is impossible");
  const [hi] = await store.addVitals(e.id, [{ type: "bp", values: { systolic: 168, diastolic: 96 } }], { takenAt: "2026-03-10T10:05" });
  assert.match(hi.flags.join(), /Above adult reference/);
  await store.addVitals(e.id, [{ type: "bp", values: { systolic: 150, diastolic: 90 } }], { takenAt: "2026-03-10T10:20" });
  await store.voidVital(hi.id, "Wrong arm cuff size");
  const all = store._related(e.id).vitals;
  assert.equal(all.length, 2, "both readings kept");
  assert.equal(all.find((v) => v.id === hi.id).values.systolic, 168, "voided reading keeps its value");
  assert.ok(all.find((v) => v.id === hi.id).voided);
  const [sure] = await store.addVitals(e.id, [{ type: "pulse", value: 260 }], { confirmUnusual: true });
  assert.match(sure.flags.join(), /confirmed by user/);
  // Children: adult ranges not applied.
  const kid = (await store.registerPatient({ name: "Baby Anu", ageYears: 4, sex: "female" })).patient;
  const ke = await store.createEncounter({ patientId: kid.id, date: D, locationId: clinic.id });
  const [kp] = await store.addVitals(ke.id, [{ type: "pulse", value: 115 }]);
  assert.ok(!kp.flags.some((f) => /adult reference \(/.test(f)));
  assert.ok(kp.flags.some((f) => /adult reference ranges not applied/.test(f)));
  assert.equal(checkVital({ type: "glucose", value: 140, context: "fasting" }, 40).flags.length, 1);
  assert.equal(bmi(170, 72.25), 25);
});

test("finalised notes are preserved; corrections become amendments", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  await store.updateEncounter(e.id, { complaints: [{ text: "Cough", duration: "2 weeks" }], assessment: "Likely post-viral cough" });
  await store.saveDiagnosis({ encounterId: e.id, kind: "primary", name: "Post-viral cough", certainty: "provisional" });
  const { version: v1 } = await store.finalizeEncounter(e.id);
  await assert.rejects(store.updateEncounter(e.id, { assessment: "changed" }), /signed/);
  await assert.rejects(store.addVitals(e.id, [{ type: "pulse", value: 80 }]), /signed/);
  await assert.rejects(store.amendEncounter(e.id, ""), /reason/);
  await store.amendEncounter(e.id, "Duration was 3 weeks, not 2");
  await store.updateEncounter(e.id, { complaints: [{ text: "Cough", duration: "3 weeks" }] });
  const { version: v2 } = await store.finalizeEncounter(e.id);
  const versions = store.encounterBundle(e.id).versions;
  assert.deepEqual(versions.map((v) => [v.version, v.kind]), [[1, "original"], [2, "amendment"]]);
  assert.match(noteToText(versions[0].note), /2 weeks/);
  assert.match(noteToText(versions[1].note), /3 weeks/);
  assert.equal(versions[1].reason, "Duration was 3 weeks, not 2");
  assert.equal(v1.snapshot.encounter.complaints[0].duration, "2 weeks", "original snapshot untouched");
  assert.ok(v2.signedAt >= v1.signedAt);
});

test("diagnoses are reviewed at later visits without overwriting earlier records", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const e1 = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  const d1 = await store.saveDiagnosis({ encounterId: e1.id, kind: "primary", name: "Hypertension", certainty: "suspected" });
  await store.finalizeEncounter(e1.id);
  const e2 = await store.createEncounter({ patientId: patient.id, date: "2026-04-10", locationId: clinic.id });
  await assert.rejects(store.saveDiagnosis({ ...d1, encounterId: e2.id, certainty: "confirmed" }), /reviewed, not edited/);
  const d2 = await store.saveDiagnosis({ encounterId: e2.id, kind: "primary", name: "Hypertension", certainty: "confirmed", reviewOf: d1.id, severity: "Stage 1" });
  assert.equal(store.get("diagnoses", d1.id).certainty, "suspected", "earlier record unchanged");
  const probs = problemList(store.patientRecord(patient.id).diagnoses);
  assert.deepEqual(probs.map((d) => [d.id, d.certainty]), [[d2.id, "confirmed"]]);
  // Symptoms never become diagnoses automatically.
  await store.updateEncounter(e2.id, { complaints: [{ text: "Chest pain" }] });
  assert.equal(store._related(e2.id).diagnoses.length, 1);
  await assert.rejects(store.saveDiagnosis({ encounterId: e2.id, kind: "primary", name: "X" }), /certain/);
});

test("prescription edits keep every version; approval is required", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  const p1 = await store.savePrescription({ encounterId: e.id, items: [{ drug: "Amlodipine", strength: "5 mg", dose: "1 tab", frequency: "OD", duration: "30 days" }] });
  await assert.rejects(store.finalizeEncounter(e.id), /draft prescription/);
  await store.approvePrescription(p1.id);
  const p2 = await store.savePrescription({ id: p1.id, encounterId: e.id, items: [{ drug: "Amlodipine", strength: "10 mg", dose: "1 tab", frequency: "OD", duration: "30 days" }] });
  assert.notEqual(p2.id, p1.id);
  assert.equal(p2.supersedes, p1.id);
  assert.equal(store.get("prescriptions", p1.id).status, "approved", "old version stays until the new one is approved");
  await store.approvePrescription(p2.id);
  assert.equal(store.get("prescriptions", p1.id).status, "superseded");
  assert.equal(store.get("prescriptions", p1.id).items[0].strength, "5 mg");
  await store.finalizeEncounter(e.id);
  const text = noteToText(store.noteFor(e.id));
  assert.match(text, /10 mg/);
  assert.doesNotMatch(text, /5 mg/);
  // Reported current medications are separate from prescriptions.
  await store.saveMedication({ patientId: patient.id, name: "Metformin 500", frequency: "BD", status: "taking" });
  const rec = store.patientRecord(patient.id);
  assert.equal(rec.medications.length, 1);
  assert.equal(rec.prescriptions.length, 2);
});

test("reports and attachments go to the right patient and encounter, never replaced", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const other = (await store.registerPatient({ name: "Sita Devi", ageYears: 61, sex: "female" })).patient;
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  const i1 = await store.saveInvestigation({ patientId: patient.id, encounterId: e.id, name: "HbA1c", category: "glucose", value: "8.2", unit: "%", resultAt: D });
  await assert.rejects(store.saveInvestigation({ ...i1, value: "7.1" }), /already recorded/);
  const i2 = await store.saveInvestigation({ patientId: patient.id, name: "HbA1c", category: "glucose", value: "7.1", unit: "%", resultAt: "2026-06-10" });
  assert.equal(store.get("investigations", i1.id).value, "8.2");
  await assert.rejects(store.saveInvestigation({ patientId: other.id, encounterId: e.id, name: "CBC" }), /another patient/);
  const f1 = await store.attachFile({ patientId: patient.id, investigationId: i1.id, name: "hba1c-march.pdf", bytes: PDF });
  const f2 = await store.attachFile({ patientId: patient.id, investigationId: i1.id, name: "hba1c-march-page2.pdf", bytes: PDF });
  assert.notEqual(f1.id, f2.id);
  await assert.rejects(store.attachFile({ patientId: other.id, investigationId: i1.id, name: "x.pdf", bytes: PDF }), /another patient/);
  await assert.rejects(store.attachFile({ patientId: patient.id, name: "evil.pdf", bytes: new TextEncoder().encode("<script>alert(1)</script>") }), /Only PDF/);
  const back = await store.readFile(f1.id);
  assert.deepEqual([...back.bytes], [...PDF]);
  assert.equal(back.patientId, patient.id);
  const raw = await store.adapter.get("blobs", f1.id);
  assert.notDeepEqual([...raw.data.subarray(0, 5)], [...PDF.subarray(0, 5)], "attachment encrypted at rest");
  assert.equal(store.patientRecord(patient.id).investigations.length, 2);
  assert.equal(store.patientRecord(other.id).investigations.length, 0);
  assert.ok(i2);
});

test("roles: receptionist and staff cannot read restricted clinical records", async () => {
  const { store, clinic, patient, ward } = await clinicalSetup();
  const rec = await addUser(store, { name: "Reception", username: "desk", role: "receptionist", password: "front desk 22" });
  const nurse = await addUser(store, { name: "Nurse Asha", username: "asha", role: "staff", password: "nurse pass 33", canClinical: true });
  const helper = await addUser(store, { name: "Helper", username: "helper", role: "staff", password: "helper pass 44" });
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  await store.updateEncounter(e.id, { complaints: [{ text: "Secret complaint" }], assessment: "Sensitive assessment" });
  await store.saveDiagnosis({ encounterId: e.id, kind: "primary", name: "Sensitive diagnosis", certainty: "confirmed" });
  await signOut(store);

  // Receptionist: billing and registration yes, clinical content no (no key at all).
  await signIn(store, rec.id, "front desk 22");
  assert.equal(store.dek, null);
  assert.throws(() => store.patientRecord(patient.id), PermissionError);
  assert.throws(() => store.encounterBundle(e.id), PermissionError);
  const enc = store.get("encounters", e.id);
  assert.equal(enc.complaints, undefined, "only metadata is in memory");
  assert.equal(enc.status, "draft");
  assert.ok(!JSON.stringify(store.data).includes("Sensitive"), "no clinical content anywhere in memory");
  await assert.rejects(store.updateEncounter(e.id, { notes: "x" }), PermissionError);
  await assert.rejects(store.addVitals(e.id, [{ type: "pulse", value: 80 }]), PermissionError);
  const p2 = await store.registerPatient({ name: "New Walk-in", ageYears: 30, sex: "female" });
  assert.ok(p2.patient);
  const v = await store.addVisit({ date: D, locationId: clinic.id, sessionName: "morning", category: "new", patientRecordId: p2.patient.id, payment: { amountPaise: R(300), method: "upi" } });
  assert.ok(v.visit);
  await assert.rejects(store.saveSettlement({ payerId: store.data.payers[0].id, periodStart: "2026-03-01", periodEnd: "2026-03-31" }), PermissionError, "settlements are doctor-only");
  assert.ok(ward);
  await signOut(store);

  // Clinical staff: vitals and reports only.
  await signIn(store, nurse.id, "nurse pass 33");
  assert.throws(() => store.patientRecord(patient.id), PermissionError);
  assert.throws(() => store.noteFor(e.id), PermissionError);
  const view = store.staffEncounterView(e.id);
  assert.equal(view.encounter.assessment, undefined);
  await store.addVitals(e.id, [{ type: "spo2", value: 97, context: "room air" }]);
  await assert.rejects(store.saveDiagnosis({ encounterId: e.id, kind: "primary", name: "x", certainty: "suspected" }), PermissionError);
  await assert.rejects(store.addVisit({ date: D, locationId: clinic.id, sessionName: "morning", category: "new" }), PermissionError, "no billing for staff");
  await signOut(store);

  // Staff without clinical access: registration only.
  await signIn(store, helper.id, "helper pass 44");
  await assert.rejects(store.addVitals(e.id, [{ type: "pulse", value: 80 }]), PermissionError);
  await signOut(store);
  await assert.rejects(signIn(store, rec.id, "wrong password!"), /Wrong password/);
  const views = store.data.clinicalAudit.filter((a) => a.action === "view");
  assert.ok(views.length >= 1, "clinical views are logged");
  assert.ok(store.data.clinicalAudit.some((a) => a.action === "sign-in-failed"));
});

test("clinical content is encrypted at rest and in backups; backups restore everything", async () => {
  const { store, clinic, patient, recoveryCode, doctor } = await clinicalSetup();
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, sessionName: "morning", billing: { mode: "new", category: "new" } });
  await store.updateEncounter(e.id, { complaints: [{ text: "Breathlessness on exertion" }] });
  await store.saveAllergy({ patientId: patient.id, substance: "Penicillin", reaction: "Urticaria" });
  const inv = await store.saveInvestigation({ patientId: patient.id, encounterId: e.id, name: "Chest X-ray", category: "xray" });
  const f = await store.attachFile({ patientId: patient.id, investigationId: inv.id, name: "cxr.pdf", bytes: PDF });
  const disk = await store.adapter.getAll("encounters");
  assert.ok(!JSON.stringify(disk).includes("Breathlessness"), "encounter content is not stored in clear");
  assert.ok(!JSON.stringify(await store.adapter.getAll("allergies")).includes("Penicillin"));

  const backup = await buildBackup(store);
  const json = JSON.stringify(backup);
  assert.ok(!json.includes("Breathlessness") && !json.includes("Penicillin"), "backup holds no clinical plaintext");
  assert.equal((await verifyBackup(JSON.parse(json))).ok, true);

  const fresh = await Store.open(memoryAdapter());
  await restoreBackup(fresh, JSON.parse(json));
  assert.equal(fresh.data.visits.length, store.data.visits.length);
  assert.deepEqual(activityTotals(fresh.ledger, {}), activityTotals(store.ledger, {}));
  assert.equal(fresh.dek, null, "restored clinical data stays locked until a doctor signs in");
  await signIn(fresh, doctor.id, "correct horse 1");
  const rec = fresh.patientRecord(patient.id);
  assert.equal(rec.encounters[0].complaints[0].text, "Breathlessness on exertion");
  assert.equal(rec.allergies[0].substance, "Penicillin");
  assert.deepEqual([...(await fresh.readFile(f.id)).bytes], [...PDF]);
  await signOut(fresh);
  // Forgotten password: the recovery code still opens the records.
  await recoverWithCode(fresh, doctor.id, recoveryCode.toLowerCase(), "brand new pass 9");
  assert.equal(fresh.patientRecord(patient.id).allergies.length, 1);
});

test("format-1 (financial only) backups still verify and restore", async () => {
  const { store, clinic } = await setup();
  await store.addVisit({ date: D, locationId: clinic.id, sessionName: "morning", category: "new", payment: { amountPaise: R(300), method: "cash" } });
  const b = await buildBackup(store);
  const v1 = { ...b, format: 1, stores: Object.fromEntries(FINANCIAL_STORES.map((s) => [s, b.stores[s]])), counts: Object.fromEntries(FINANCIAL_STORES.map((s) => [s, b.counts[s]])) };
  const { webcrypto } = await import("node:crypto");
  const canon = (x) => (Array.isArray(x) ? "[" + x.map(canon).join(",") + "]" : x && typeof x === "object" ? "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",") + "}" : JSON.stringify(x === undefined ? null : x));
  v1.checksum = [...new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(canon(v1.stores))))].map((x) => x.toString(16).padStart(2, "0")).join("");
  assert.equal((await verifyBackup(v1)).ok, true);
  const fresh = await Store.open(memoryAdapter());
  await restoreBackup(fresh, v1);
  assert.deepEqual(activityTotals(fresh.ledger, {}), activityTotals(store.ledger, {}));
});

test("summary sessions work without clinical records and link to encounters later without double counting", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const { session } = await store.saveSummarySession({ date: D, locationId: clinic.id, sessionName: "morning", lines: lines(store, clinic.id, D, { new: 10 }), collections: { cash: R(3000) } });
  const base = activityTotals(store.ledger, {});
  assert.equal(base.visits, 10);
  // Encounter documented against the session with no charge: nothing changes.
  await store.createEncounter({ patientId: patient.id, date: D, sessionId: session.id, billing: { mode: "none" } });
  assert.deepEqual(activityTotals(store.ledger, {}), base);
  // Encounter that also records the individual visit into the summary session:
  // the session goes to reconciliation and is still counted once.
  await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, sessionName: "morning", billing: { mode: "new", category: "new", payment: { amountPaise: R(300), method: "cash" } } });
  const s = store.get("sessions", session.id);
  assert.equal(s.mode, "summary_recon");
  assert.equal(activityTotals(store.ledger, {}).visits, 10, "summary counted, the visit is detail");
  assert.equal(collectionTotals(store.ledger, {}).patient, R(3000));
});

test("clinical and financial cancellation are independent", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, sessionName: "morning", billing: { mode: "new", category: "new" } });
  await store.cancelEncounter(e.id, "Patient left before consultation");
  assert.equal(store.get("visits", e.visitId).cancelled, false, "charge untouched");
  assert.equal(activityTotals(store.ledger, {}).visits, 1);
  await store.cancelVisit(e.visitId, "No consultation took place");
  assert.equal(activityTotals(store.ledger, {}).visits, 0);
  const e2 = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id, sessionName: "evening", billing: { mode: "new", category: "new" } });
  await store.cancelVisit(e2.visitId, "Fee not charged: staff family");
  assert.equal(store.get("encounters", e2.id).status, "draft", "clinical record untouched");
  assert.ok(store.data.audit.some((a) => a.action === "cancel" && a.entityId === e2.visitId));
  assert.ok(store.data.clinicalAudit.some((a) => a.action === "cancel" && a.entityId === e.id));
});

test("duplicate patients are warned about, never merged", async () => {
  const { store } = await clinicalSetup();
  const r1 = await store.registerPatient({ name: "Mr. Ramesh  Kumar", ageYears: 55, sex: "male" });
  assert.equal(r1.needsConfirm, true);
  assert.match(r1.matches[0].reasons.join(), /same name/);
  const r2 = await store.registerPatient({ name: "Suresh", mobile: "+91 98765 43210" });
  assert.match(r2.matches[0].reasons.join(), /same mobile/);
  const r3 = await store.registerPatient({ name: "Kumar Ramesh", ageYears: 54 }, { confirmNew: true });
  assert.ok(r3.patient);
  assert.equal(store.data.patients.length, 2, "kept as separate profiles");
  assert.equal(findPatientMatches(store.data.patients, { name: "Totally Different", ageYears: 20 }).length, 0);
});

test("consultation note includes what was recorded, nothing else", async () => {
  const { store, clinic, patient } = await clinicalSetup();
  const e = await store.createEncounter({ patientId: patient.id, date: D, locationId: clinic.id });
  await store.updateEncounter(e.id, { complaints: [{ text: "Headache", duration: "1 week", negatives: "vomiting" }] });
  const note = store.noteFor(e.id);
  const text = noteToText(note);
  assert.match(text, /Headache × 1 week; no vomiting/);
  assert.doesNotMatch(text, /Examination/, "unexamined systems are not reported as normal");
  assert.match(text, /Allergy status not recorded/);
  const soap = noteToText(composeNote(store._noteContext(store.get("encounters", e.id)), { ...store.noteTemplate, style: "soap" }));
  assert.match(soap, /S — Subjective/i);
});

test("audit log: patient identity redacted, location names kept", async () => {
  const { store, patient } = await clinicalSetup();
  await store.updatePatient(patient.id, { mobile: "9123456780" }, "new number");
  const log = JSON.stringify(store.data.audit);
  assert.ok(!log.includes("Ramesh") && !log.includes("9123456780"));
  assert.ok(log.includes("Own clinic"), "financial audit keeps location names");
});

test("a brand-new device is not reported as an upgrade", async () => {
  const a = await openIndexedDB("fresh-" + Math.random());
  assert.equal(a.migration, null);
  a.close();
});
