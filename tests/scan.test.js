// Handwritten prescription scanner: reader contract, review rules, import safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { setup, R } from "./helpers.js";
import "../js/clinical-store.js";
import "../js/scan-store.js";
import { Store, PermissionError } from "../js/store.js";
import { memoryAdapter, openIndexedDB } from "../js/db.js";
import { setupFirstDoctor, addUser, signIn, signOut } from "../js/auth.js";
import { activityTotals, collectionTotals } from "../js/calc.js";
import { buildBackup, restoreBackup, verifyBackup } from "../js/backup.js";
import { validateExtraction, toReviewFields, scanFlags, EXTRACTION_SCHEMA } from "../js/ocr/schema.js";
import { matchMedicine } from "../js/ocr/medicines.js";
import { interpretFrequency, interpretDuration } from "../js/ocr/abbreviations.js";
import { homography, applyH, warpPerspective, adaptiveThreshold } from "../js/ocr/geometry.js";
import { buildRequest, readPrescription, MODEL } from "../js/ocr/claude.js";
import { parseVital, parseWrittenDate } from "../js/scan-store.js";
import { feverRx, hindiRx, unreadableRx, conflictRx } from "./fixtures/prescriptions.js";
import { DB_SCHEMA_VERSION } from "../js/model.js";

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 1, 2, 3, 4]);
const ex = (raw) => validateExtraction(structuredClone(raw)).extraction;

async function scanSetup(raw = feverRx) {
  const s = await setup();
  await setupFirstDoctor(s.store, { name: "Dr Daklia", password: "correct horse 1", iterations: 1000 });
  const { patient } = await s.store.registerPatient({ name: "Ramesh Kumar", ageYears: 54, sex: "male" });
  const scan = await s.store.createScan({ patientId: patient.id, original: { bytes: JPG, name: "rx.jpg" }, provider: "claude", result: { extraction: ex(raw), model: MODEL, validationErrors: [] } });
  const F = (pred) => scan.fields.find(pred);
  return { ...s, patient, scan, F };
}
const byLabel = (scan, label) => scan.fields.find((f) => f.label === label);

test("reader output is validated and normalised; nothing is invented", () => {
  const raw = structuredClone(feverRx);
  raw.patient.mobile = { text: "", legibility: "clear", confidence: 85, alternatives: ["x"] };
  raw.medications[0].dose.confidence = 95;
  const { extraction, errors } = validateExtraction(raw);
  assert.equal(extraction.patient.mobile.text, null);
  assert.equal(extraction.patient.mobile.legibility, "clear", "null + clear = not written (absent), not illegible");
  assert.ok(!toReviewFields(extraction).some((f) => f.section === "patient" && f.key === "mobile"), "absent fields are not listed");
  assert.equal(extraction.medications[0].dose.confidence, 0.95, "percentages tolerated");
  assert.deepEqual(errors, []);
  assert.throws(() => validateExtraction(null));
  const bad = validateExtraction({ medications: [{ name: { text: "Dolo", legibility: "weird", confidence: 1, alternatives: [] } }] });
  assert.ok(bad.errors.length);
  assert.equal(bad.extraction.medications[0].name.legibility, "unclear", "unknown legibility treated as unclear");
  // Schema is strict: every object closed, every property required.
  const check = (s) => {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(Object.keys(s.properties).sort(), [...s.required].sort());
      Object.values(s.properties).forEach(check);
    }
    if (s.type === "array") check(s.items);
  };
  check(EXTRACTION_SCHEMA);
});

test("medicine catalogue: brands map to generics; near-misses are suggested, never substituted", () => {
  assert.equal(matchMedicine("Tab Dolo 650").match.generic, "paracetamol");
  assert.equal(matchMedicine("T. Pan-D 40").match.name, "Pan-D");
  assert.equal(matchMedicine("Telma-H 40").match.generic, "telmisartan + hydrochlorothiazide");
  const az = matchMedicine("Azithrol 500");
  assert.equal(az.status, "similar");
  assert.deepEqual(az.suggestions.map((s) => s.name), ["Azithral"]);
  assert.equal(matchMedicine("Augmentin 625 Duo").status, "partial", "a variant is not an exact match");
  assert.equal(matchMedicine("Qwertyzol").status, "none");
  const fields = toReviewFields(ex(feverRx));
  const az2 = fields.find((f) => f.group === "md1" && f.key === "name");
  assert.equal(az2.value, "Tab Azithrol 500", "the written name is kept");
  assert.ok(az2.flags.some((f) => f.code === "similar_name"));
  assert.ok(fields.find((f) => f.group === "md0" && f.key === "name").hints.some((h) => /paracetamol/.test(h)));
});

test("shorthand and Hindi instructions produce hints only", () => {
  assert.deepEqual(interpretFrequency("1-0-1"), { meaning: "1 morning, 1 night", perDay: 2 });
  assert.equal(interpretFrequency("BD").meaning, "twice daily");
  assert.equal(interpretFrequency("½-0-½").perDay, 1);
  assert.equal(interpretFrequency("सुबह खाने के बाद").meaning, "morning, after food");
  assert.equal(interpretFrequency("xyz"), null);
  assert.equal(interpretDuration("x 5d").days, 5);
  assert.equal(interpretDuration("5/7").meaning, "5 days");
  assert.equal(interpretDuration("2/52").days, 14);
  assert.equal(interpretDuration("1 महीने").meaning, "1 month");
  const f = toReviewFields(ex(feverRx)).find((x) => x.group === "md0" && x.key === "frequency");
  assert.equal(f.value, "1-0-1", "value stays as written");
  assert.ok(f.hints.includes("Reads as: 1 morning, 1 night"));
});

test("uncertain, illegible, missing and conflicting information is flagged", () => {
  const f = toReviewFields(ex(feverRx));
  const freq = f.find((x) => x.group === "md2" && x.key === "frequency");
  assert.ok(freq.flags.some((x) => x.code === "unclear") && freq.flags.some((x) => x.code === "ambiguous"));
  assert.ok(f.find((x) => x.group === "md2" && x.key === "duration").flags.some((x) => x.code === "missing"));
  const h = toReviewFields(ex(hindiRx));
  const ill = h.find((x) => x.group === "md1" && x.key === "frequency");
  assert.equal(ill.value, null);
  assert.ok(ill.flags.some((x) => x.code === "illegible"));
  assert.ok(scanFlags(ex(unreadableRx)).some((x) => x.code === "unreadable"));
  assert.ok(scanFlags(ex(conflictRx)).some((x) => x.code === "conflict"));
  const dx = f.find((x) => x.section === "diagnoses");
  assert.equal(dx.meta.certainty, "suspected", "'?' diagnosis defaults to suspected, never confirmed");
  assert.ok(toReviewFields(ex(hindiRx)).filter((x) => x.section === "diagnoses").every((x) => x.meta.certainty !== "confirmed"));
});

test("approval rules: uncertain critical medicine fields must be typed, others checked", async () => {
  const { store, scan, F } = await scanSetup();
  const azName = F((f) => f.group === "md1" && f.key === "name");
  await assert.rejects(store.reviewScanField(scan.id, azName.id, { action: "approve" }), /Type exactly what you read/);
  await assert.rejects(store.reviewScanField(scan.id, azName.id, { action: "approve", verified: true }), /Type exactly/, "ticking 'checked' is not enough for a drug name");
  await store.reviewScanField(scan.id, azName.id, { action: "edit", value: "Tab Azithral 500" });
  await store.reviewScanField(scan.id, azName.id, { action: "approve" });
  const missingDur = F((f) => f.group === "md2" && f.key === "duration");
  await assert.rejects(store.reviewScanField(scan.id, missingDur.id, { action: "approve" }), /Nothing to approve/);
  const cough = F((f) => f.section === "complaints" && f.group === "cc1" && f.key === "complaint");
  await assert.rejects(store.reviewScanField(scan.id, cough.id, { action: "approve" }), /checked it against the image/);
  await store.reviewScanField(scan.id, cough.id, { action: "approve", verified: true });
  const dx = F((f) => f.section === "diagnoses");
  await store.reviewScanField(scan.id, dx.id, { action: "meta", meta: { certainty: "confirmed" } });
  await store.reviewScanField(scan.id, dx.id, { action: "approve" }); // clear reading: doctor may confirm
  const s2 = store.get("scans", scan.id);
  const hist = s2.fields.find((f) => f.id === azName.id).history.map((h) => h.action);
  assert.deepEqual(hist, ["edit", "approve"]);
  assert.equal(s2.fields.find((f) => f.id === azName.id).extracted.text, "Tab Azithrol 500", "original reading preserved");
  assert.equal(s2.extraction.medications[1].name.text, "Tab Azithrol 500");
});

test("an ambiguous diagnosis can never be imported as confirmed", async () => {
  const raw = structuredClone(feverRx);
  raw.diagnoses = [{ diagnosis: { text: "Enteric fever", legibility: "unclear", confidence: 0.6, alternatives: ["Enteritis"] }, written_qualifier: "none" }];
  const { store, scan, F } = await scanSetup(raw);
  const dx = F((f) => f.section === "diagnoses");
  await store.reviewScanField(scan.id, dx.id, { action: "meta", meta: { certainty: "confirmed" } });
  await assert.rejects(store.reviewScanField(scan.id, dx.id, { action: "approve", verified: true }), /cannot be approved as confirmed/);
  await store.reviewScanField(scan.id, dx.id, { action: "meta", meta: { certainty: "provisional" } });
  await store.reviewScanField(scan.id, dx.id, { action: "approve", verified: true });
  assert.equal(store.get("scans", scan.id).fields.find((f) => f.id === dx.id).status, "approved");
});

test("import: new paper-prescription consultation, no fee, no prescription, provenance kept", async () => {
  const { store, scan, F, clinic, patient } = await scanSetup();
  const fin0 = { act: activityTotals(store.ledger, {}), col: collectionTotals(store.ledger, {}), visits: store.data.visits.length, payments: store.data.payments.length };
  const approve = (pred, opts = {}) => store.reviewScanField(scan.id, F(pred).id, { action: "approve", ...opts });
  await approve((f) => f.section === "complaints" && f.group === "cc0" && f.key === "complaint");
  await approve((f) => f.section === "complaints" && f.group === "cc0" && f.key === "duration");
  await approve((f) => f.section === "comorbidities" && f.group === "cm0");
  await approve((f) => f.section === "vitals" && f.meta.vitalType === "bp");
  await approve((f) => f.section === "vitals" && f.meta.vitalType === "temp");
  await approve((f) => f.section === "diagnoses");
  // Written as normal on the page -> status pre-set from the writing; still needs approval.
  const exf = F((f) => f.section === "examination");
  assert.equal(exf.meta.status, "normal");
  await store.reviewScanField(scan.id, exf.id, { action: "approve" });
  for (const k of ["name", "dose", "frequency", "duration", "timing"]) await approve((f) => f.group === "md0" && f.key === k, { verified: true });
  // An unwritten examination status (unclear) must be chosen by the doctor.
  const raw = structuredClone(feverRx);
  raw.examination[0].written_status = "unclear";
  const f2 = toReviewFields(ex(raw)).find((f) => f.section === "examination");
  assert.equal(f2.meta.status, null);
  await approve((f) => f.section === "investigations" && f.group === "in0");
  await approve((f) => f.section === "advice" && f.group === "ad0");
  await approve((f) => f.section === "followup" && f.key === "interval");
  await approve((f) => f.section === "document" && f.key === "date");

  // Not confirmed patient yet: the prescription names a patient, and it matches.
  assert.equal(store.get("scans", scan.id).patientCheck.result, "match");
  // Temperature written as 101 (°F) must be corrected before import; nothing is written meanwhile.
  await assert.rejects(store.importScan(scan.id, { mode: "new", locationId: clinic.id }), /Nothing was imported:[\s\S]*°F/);
  assert.equal(store.data.encounters.length, 0);
  const temp = F((f) => f.meta.vitalType === "temp");
  await store.reviewScanField(scan.id, temp.id, { action: "edit", value: "38.3 °C" });
  await store.reviewScanField(scan.id, temp.id, { action: "approve" });

  const r = await store.importScan(scan.id, { mode: "new", locationId: clinic.id });
  const e = store.get("encounters", r.encounterId);
  assert.equal(e.type, "scan");
  assert.equal(e.date, "2026-03-12", "dated from the approved prescription date");
  assert.equal(e.visitId, null, "no fee");
  assert.equal(e.status, "draft", "the doctor still reviews and signs it");
  assert.deepEqual(e.complaints.map((c) => [c.text, c.duration]), [["fever", "3 days"]]);
  assert.equal(e.complaints[0].source.scanId, scan.id);
  assert.equal(e.exam.find((x) => x.key === "rs").findings, "B/L air entry equal, no crepts");
  const rel = store._related(e.id);
  assert.deepEqual(rel.vitals.map((v) => v.type).sort(), ["bp", "temp"]);
  assert.ok(rel.vitals.every((v) => v.source && v.source.scanId === scan.id));
  assert.equal(rel.diagnoses[0].certainty, "suspected");
  assert.equal(rel.prescriptions.length, 0, "no prescription is generated from OCR");
  const meds = store.data.medications.filter((m) => m.patientId === patient.id);
  assert.equal(meds.length, 1);
  assert.equal(meds[0].status, "unknown", "imported as unverified medicine history");
  assert.equal(meds[0].lastVerifiedAt, null);
  assert.match(meds[0].notes, /Not prescribed in this app/);
  assert.equal(store.data.conditions[0].name, "DM");
  assert.equal(store.data.conditions[0].status, "current");
  assert.equal(store.data.investigations[0].name, "CBC");
  assert.deepEqual({ act: activityTotals(store.ledger, {}), col: collectionTotals(store.ledger, {}), visits: store.data.visits.length, payments: store.data.payments.length }, fin0, "no financial effect");
  const s2 = store.get("scans", scan.id);
  assert.equal(s2.status, "partially_imported");
  assert.ok(s2.fields.filter((f) => f.status === "imported").length >= 10);
  assert.equal(s2.importLog.length, 1);
  // Imported fields are locked; importing again creates nothing new.
  const imported = s2.fields.find((f) => f.status === "imported");
  await assert.rejects(store.reviewScanField(scan.id, imported.id, { action: "edit", value: "x" }), /already in the record/);
  await assert.rejects(store.importScan(scan.id, { mode: "new", locationId: clinic.id }), /Approve at least one/);
  // Original image kept as an encrypted attachment.
  assert.deepEqual([...(await store.readFile(s2.originalFileId)).bytes], [...JPG]);
});

test("import into an existing consultation appends — never overwrites notes or prescriptions", async () => {
  const { store, scan, F, clinic, patient } = await scanSetup();
  const enc = await store.createEncounter({ patientId: patient.id, date: "2026-03-12", locationId: clinic.id });
  const rs = structuredClone(store.get("encounters", enc.id).exam);
  rs.find((x) => x.key === "rs").status = "abnormal";
  rs.find((x) => x.key === "rs").findings = "Crepts right base";
  await store.updateEncounter(enc.id, { complaints: [{ text: "Breathlessness", duration: "1 day" }], exam: rs, notes: "Doctor's own note" });
  const rx = await store.savePrescription({ encounterId: enc.id, items: [{ drug: "Paracetamol", dose: "1 tab", frequency: "TDS" }] });
  await store.approvePrescription(rx.id);
  await store.reviewScanField(scan.id, F((f) => f.group === "cc0" && f.key === "complaint").id, { action: "approve" });
  await store.reviewScanField(scan.id, F((f) => f.section === "examination").id, { action: "approve", verified: true });
  for (const k of ["name", "dose", "frequency", "duration"]) await store.reviewScanField(scan.id, F((f) => f.group === "md0" && f.key === k).id, { action: "approve" });
  await store.importScan(scan.id, { mode: "encounter", encounterId: enc.id });
  const e = store.get("encounters", enc.id);
  assert.deepEqual(e.complaints.map((c) => c.text), ["Breathlessness", "fever"]);
  assert.match(e.exam.find((x) => x.key === "rs").findings, /^Crepts right base \[from scanned prescription: B\/L air entry equal/);
  assert.equal(e.exam.find((x) => x.key === "rs").status, "abnormal", "existing status kept");
  assert.match(e.notes, /^Doctor's own note\nImported from scanned prescription/);
  const rxs = store._related(enc.id).prescriptions;
  assert.equal(rxs.length, 1);
  assert.equal(rxs[0].items[0].drug, "Paracetamol", "existing prescription untouched");
  // A signed consultation cannot receive imports.
  await store.finalizeEncounter(enc.id);
  const again = await store.createScan({ patientId: patient.id, original: { bytes: JPG, name: "rx2.jpg" }, provider: "claude", result: { extraction: ex(feverRx), model: MODEL } });
  await store.reviewScanField(again.id, again.fields.find((f) => f.group === "cc0" && f.key === "complaint").id, { action: "approve" });
  await assert.rejects(store.importScan(again.id, { mode: "encounter", encounterId: enc.id }), /signed/);
});

test("patient identity: mismatches must be confirmed; nothing imports to an unconfirmed patient", async () => {
  const { store, scan, F, clinic } = await scanSetup(conflictRx);
  const s = store.get("scans", scan.id);
  assert.equal(s.patientCheck.result, "mismatch");
  assert.match(s.patientCheck.reasons.join(), /Suresh Patel/);
  await store.reviewScanField(scan.id, F((f) => f.group === "cc0" && f.key === "complaint").id, { action: "approve" });
  await assert.rejects(store.importScan(scan.id, { mode: "new", locationId: clinic.id }), /Confirm the patient/);
  await store.confirmScanPatient(scan.id);
  await store.importScan(scan.id, { mode: "new", locationId: clinic.id });
  // A conflicting second strength stays flagged and needs typing.
  const second = F((f) => f.group === "md1" && f.key === "name");
  await assert.rejects(store.reviewScanField(scan.id, second.id, { action: "approve", verified: true }), /Type exactly/);
});

test("manual entry (no cloud) uses the same review and import", async () => {
  const s = await setup();
  await setupFirstDoctor(s.store, { name: "Dr D", password: "correct horse 1", iterations: 1000 });
  const { patient } = await s.store.registerPatient({ name: "Asha", ageYears: 30, sex: "female" });
  const scan = await s.store.createScan({ patientId: patient.id, original: { bytes: JPG, name: "rx.jpg" }, provider: "manual" });
  assert.equal(scan.fields.length, 0);
  assert.equal(scan.patientCheck.result, "not_written");
  const s1 = await s.store.addScanField(scan.id, { section: "medications", group: "md0", key: "name", label: "Medicine 1 — name", value: "Tab Shelcal 500" });
  await s.store.addScanField(scan.id, { section: "medications", group: "md0", key: "frequency", label: "Medicine 1 — frequency", value: "OD" });
  for (const f of s.store.get("scans", scan.id).fields) await s.store.reviewScanField(scan.id, f.id, { action: "approve" });
  await assert.rejects(s.store.importScan(scan.id, { mode: "new", locationId: s.clinic.id }), /Confirm this prescription belongs/);
  await s.store.confirmScanPatient(scan.id);
  await s.store.importScan(scan.id, { mode: "new", locationId: s.clinic.id, date: "2026-10-01" });
  assert.equal(s.store.data.medications[0].name, "Tab Shelcal 500");
  assert.ok(s1);
});

test("access: receptionists cannot see or create scans; staff cannot import", async () => {
  const { store, scan, clinic, patient } = await scanSetup();
  const desk = await addUser(store, { name: "Desk", username: "desk", role: "receptionist", password: "front desk 22" });
  const nurse = await addUser(store, { name: "Nurse", username: "nurse", role: "staff", password: "nurse pass 33", canClinical: true });
  await signOut(store);
  await signIn(store, desk.id, "front desk 22");
  const s = store.get("scans", scan.id);
  assert.equal(s.fields, undefined, "only metadata without the key");
  assert.ok(!JSON.stringify(store.data.scans).includes("Dolo"));
  await assert.rejects(store.createScan({ patientId: patient.id, original: { bytes: JPG }, provider: "manual" }), PermissionError);
  await signOut(store);
  await signIn(store, nurse.id, "nurse pass 33");
  await assert.rejects(store.importScan(scan.id, { mode: "new", locationId: clinic.id }), PermissionError);
  await assert.rejects(store.saveOcrSettings({ enabled: true, apiKey: "sk-x" }), PermissionError);
});

test("API key is stored encrypted; only same-site proxies or the Anthropic API are allowed", async () => {
  const { store } = await scanSetup();
  await assert.rejects(store.saveOcrSettings({ enabled: true, apiKey: "sk-ant-x", baseURL: "https://evil.example.com" }), /security policy/);
  await store.saveOcrSettings({ enabled: true, apiKey: "sk-ant-secret-key" });
  assert.equal(store.ocrSettings.apiKey, "sk-ant-secret-key");
  assert.ok(!JSON.stringify(await store.adapter.getAll("secrets")).includes("sk-ant-secret-key"), "encrypted at rest");
  const backup = JSON.stringify(await buildBackup(store));
  assert.ok(!backup.includes("sk-ant-secret-key") && !backup.includes("Dolo"), "backup holds neither key nor extracted text in clear");
  assert.equal((await verifyBackup(JSON.parse(backup))).ok, true);
  const fresh = await Store.open(memoryAdapter());
  await restoreBackup(fresh, JSON.parse(backup));
  await signIn(fresh, fresh.data.users[0].id, "correct horse 1");
  assert.equal(fresh.data.scans.length, 1);
  assert.equal(fresh.data.scans[0].fields.length > 0, true);
});

test("cloud reader: request shape, structured output, refusal and error handling", async () => {
  const req = buildRequest({ bytes: JPG, mime: "image/jpeg" });
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.output_config.effort, "high");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.fallbacks, "default");
  assert.equal(req.messages[0].content[0].type, "image");
  assert.equal(req.messages[0].content[0].source.media_type, "image/jpeg");
  assert.ok(!JSON.stringify(req).includes("Ramesh"), "no patient data from the record is sent");
  assert.equal(buildRequest({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mime: "application/pdf" }).messages[0].content[0].type, "document");
  const fake = (res) => ({ beta: { messages: { create: async (body) => ((fake.last = body), typeof res === "function" ? res() : res) } } });
  const ok = await readPrescription({ client: fake({ stop_reason: "end_turn", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(feverRx) }], usage: { input_tokens: 1, output_tokens: 2 } }), bytes: JPG, mime: "image/jpeg" });
  assert.equal(ok.extraction.medications.length, 4);
  await assert.rejects(readPrescription({ client: fake({ stop_reason: "refusal", content: [] }), bytes: JPG, mime: "image/jpeg" }), (e) => e.code === "refusal");
  await assert.rejects(readPrescription({ client: fake({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }), bytes: JPG, mime: "image/jpeg" }), (e) => e.code === "truncated");
  await assert.rejects(readPrescription({ client: fake({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }), bytes: JPG, mime: "image/jpeg" }), (e) => e.code === "parse");
  const authErr = Object.assign(new Error("invalid x-api-key"), { status: 401 });
  await assert.rejects(readPrescription({ client: fake(() => { throw authErr; }), bytes: JPG, mime: "image/jpeg" }), (e) => e.code === "auth");
  await assert.rejects(readPrescription({ client: fake({}), bytes: JPG, mime: "image/gif" }), (e) => e.code === "type");
});

test("image geometry: perspective correction and ink threshold", () => {
  const quad = [{ x: 10, y: 20 }, { x: 90, y: 10 }, { x: 95, y: 80 }, { x: 5, y: 90 }];
  const rect = [{ x: 0, y: 0 }, { x: 49, y: 0 }, { x: 49, y: 59 }, { x: 0, y: 59 }];
  const H = homography(rect, quad);
  rect.forEach((p, i) => {
    const q = applyH(H, p.x, p.y);
    assert.ok(Math.abs(q.x - quad[i].x) < 1e-6 && Math.abs(q.y - quad[i].y) < 1e-6);
  });
  // A 100×100 image with a dark square; warping the full frame preserves it.
  const W = 100;
  const data = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) data.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3);
  const out = warpPerspective({ data, width: W, height: W }, [{ x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 99 }, { x: 0, y: 99 }], { width: 50, height: 50 });
  assert.equal(out.data[(25 * 50 + 25) * 4], 0);
  assert.equal(out.data[(5 * 50 + 5) * 4], 255);
  const t = adaptiveThreshold({ data: out.data, width: 50, height: 50 }, { radius: 6, offset: 10 });
  assert.ok([...t.data].every((v, i) => i % 4 === 3 || v === 0 || v === 255));
  assert.throws(() => homography(rect, [quad[0], quad[0], quad[0], quad[0]]), /degenerate/);
  assert.deepEqual(parseVital("bp", "150/90 mmHg"), { type: "bp", values: { systolic: 150, diastolic: 90 } });
  assert.equal(parseVital("glucose", "246 mg/dl", "RBS").context, "random");
  assert.equal(parseVital("pulse", "--"), null);
  assert.equal(parseWrittenDate("12/3/26", "2026-10-22"), "2026-03-12");
  assert.equal(parseWrittenDate("05-09-2026"), "2026-09-05");
  assert.equal(parseWrittenDate("12 Mar 2026"), "2026-03-12");
  assert.equal(parseWrittenDate("3rd Sept 25", "2026-10-22"), "2025-09-03");
  assert.equal(parseWrittenDate("31/2/26"), null, "impossible date is not guessed");
  assert.equal(parseWrittenDate("12/3"), null, "no year: not guessed");
});

test("schema 2 → 3 upgrade keeps clinical data and adds the scans store", async () => {
  const name = "v2-" + Math.random();
  // Build a v2 database through the current code, then downgrade its version number.
  const v2 = await new Promise((res, rej) => {
    const r = indexedDB.open(name, 2);
    r.onupgradeneeded = () => ["locations", "visits", "patients", "encounters", "meta", "snapshots", "audit"].forEach((s) => r.result.createObjectStore(s, { keyPath: "id" }));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res) => {
    const tx = v2.transaction(["patients", "encounters", "visits"], "readwrite");
    tx.objectStore("patients").put({ id: "PT-1", name: "Old patient" });
    tx.objectStore("encounters").put({ id: "E-1", patientId: "PT-1", status: "finalized", enc: { iv: "x", ct: "y" } });
    tx.objectStore("visits").put({ id: "V-1", sessionId: "S-1" });
    tx.oncomplete = res;
  });
  v2.close();
  const a = await openIndexedDB(name);
  assert.deepEqual([a.migration.from, a.migration.to], [2, DB_SCHEMA_VERSION]);
  const snap = await a.get("snapshots", a.migration.snapshotId);
  assert.equal(snap.stores.encounters[0].enc.ct, "y", "pre-upgrade copy includes the (encrypted) clinical records");
  const all = await a.loadAll();
  assert.ok(Array.isArray(all.scans));
  assert.equal(all.patients[0].name, "Old patient");
  a.close();
});

test("page edges are found automatically in a photo (or not guessed)", async () => {
  const { detectPage } = await import("../js/ocr/geometry.js");
  // 400×300 dark table with a bright, slightly rotated sheet, plus "ink" strokes.
  const W = 400, Hh = 300;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const sheet = [{ x: 80, y: 40 }, { x: 330, y: 60 }, { x: 310, y: 270 }, { x: 60, y: 250 }];
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = sheet[i], b = sheet[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const v = inside(x, y) ? ((y % 23 < 2 && x % 7 < 5) ? 40 : 235) : 60;
    data[o] = data[o + 1] = data[o + 2] = v;
    data[o + 3] = 255;
  }
  const q = detectPage({ data, width: W, height: Hh });
  assert.ok(q, "page found");
  q.forEach((p, i) => assert.ok(Math.hypot(p.x - sheet[i].x, p.y - sheet[i].y) < 12, `corner ${i} within 12 px (${Math.round(p.x)},${Math.round(p.y)})`));
  // A photo that is all paper (no background) gives no guess.
  const white = new Uint8ClampedArray(W * Hh * 4).fill(240);
  assert.equal(detectPage({ data: white, width: W, height: Hh }), null);
});

test("swapped letters are suggested, imported lists extend the catalogue (suggestions only)", async () => {
  const { matchMedicine, buildCatalogue, parseMedicineList, editDistance } = await import("../js/ocr/medicines.js");
  assert.equal(editDistance("azitrhal", "azithral"), 1, "transposition counts once");
  assert.deepEqual(matchMedicine("Tab Azitrhal 500").suggestions.map((s) => s.name), ["Azithral"]);
  const { items, skipped } = parseMedicineList("name,generic\nNicip Plus,nimesulide + paracetamol\nCalpol 650,paracetamol\n----\nCalpol 650,dup\n");
  assert.deepEqual(items.map((x) => x.name), ["Nicip Plus", "Calpol 650"]);
  assert.equal(skipped, 1);
  const cat = buildCatalogue(items);
  assert.equal(matchMedicine("Nicip Plus", cat).status, "exact");
  assert.equal(matchMedicine("Nicip Pls", cat).status, "similar");
  // Through the store: the doctor's imported list is used when a scan is read.
  const { store, patient } = await scanSetup();
  await store.saveTemplate({ kind: "catalogue", name: "list", data: { items: [{ name: "Ascoril", generic: "bromhexine + guaifenesin + terbutaline" }] } });
  const sc = await store.createScan({ patientId: patient.id, original: { bytes: JPG, name: "x.jpg" }, provider: "claude", result: { extraction: ex(feverRx), model: MODEL } });
  const asc = sc.fields.find((f) => f.group === "md2" && f.key === "name");
  assert.equal(asc.meta.catalogue.status, "exact");
  assert.equal(asc.value, "Syp Ascoril", "written name unchanged");
});
