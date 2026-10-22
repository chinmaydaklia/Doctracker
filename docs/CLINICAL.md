# Clinical patient records — upgrade design

Scanned paper prescriptions (schema 3) are described in [SCANNER.md](SCANNER.md).

This upgrade adds clinical records to the existing consultation and income tracker. It extends the app: no existing store, record, calculation or screen was removed or reset. The financial design is unchanged and is described in [DESIGN.md](DESIGN.md).

## 1. What already existed (inspection)

| Area | Existing entity | Notes |
|---|---|---|
| Locations & fees | `locations`, `rates` | effective-dated fee schedules |
| Hospitals | `payers`, `agreements`, `settlements` | settlement ledger |
| Work done | `sessions` (summary / individual / summary+reconciliation), `visits` | one session = one OPD/round at one location |
| Money | `payments`, `allocations`, `adjustments` | integer paise |
| Patient identity | `visits.patientId` (free-text OPD no.) and `visits.patientName`, both optional | **no patient master existed**: identity lived only on each visit |
| Safety | `audit`, `backups`, `meta`, `snapshots` | |

Storage was IndexedDB schema version 1, and backups used format 1.

## 2. Architecture

The app stays an offline, installable PWA with no backend. Additions:

```
js/clinical.js         pure helpers: age, duplicate matching, vitals checks, BMI, problem list,
                       follow-ups, note composition (no storage, no DOM)
js/clinical-store.js   clinical operations installed onto Store (patients, profile, encounters,
                       vitals, diagnoses, investigations, files, prescriptions, sign-off)
js/crypto.js           Web Crypto: AES-GCM data key, PBKDF2 password keys, recovery code
js/auth.js             local accounts, roles, sign-in, recovery
js/ui/patients.js      search, registration, profile, timeline, vitals trends, reports, medicines
js/ui/encounter.js     start consultation, editor, sign-off/amend, note preview/print/export
js/ui/security.js      sign-in, first setup, users & roles, access log
```

**Separation.** There are four kinds of record, each with its own store, status and audit trail:

1. **Patient identity:** `patients`.
2. **Clinical encounters** and their child records.
3. **Financial visits:** `visits`.
4. **Payments.**

They are linked by ID only:
- `encounters.visitId` → the financial visit (optional).
- `encounters.sessionId` → the session.
- `visits.patientRecordId` → the patient (optional).

**Authorization is enforced in one place.** `Store.commit()` checks the signed-in role's permission for every store it writes. That covers both financial and clinical writes, from the UI or anything else. The UI hides what a role cannot use, but it is not the protection.

## 3. Migration plan (as implemented)

1. On first start of the new version, `openIndexedDB` opens the database at its current version.
2. If that is version 1 and holds data, it copies **every financial record** into the existing `snapshots` store as "Before upgrade (schema 1 → 2)". This happens before anything else.
3. The database is reopened at version 2. The upgrade only **creates the new object stores**. Existing stores and records are not touched: no rewrite, no re-keying, no deletion.
4. `More` shows a one-time prompt to make a fresh backup. *Backup & restore → Safety copies* can restore the pre-upgrade copy.
5. Backups are now format 2. Format-1 backups still verify and restore; the new stores simply start empty. Restoring a format-1 backup over clinical data shows an explicit warning, and a safety copy is kept first.
6. Existing visits keep their free-text patient ID and name. Nothing is auto-converted into patient records, because guessing identities from free text would create wrong or duplicate profiles. A visit can be linked to a patient at any time (session → visit → *Link to patient*). Linking never changes money.

**Compatibility risks and how they are handled**

| Risk | Handling |
|---|---|
| Upgrade fails half-way | IndexedDB upgrades are transactional; the pre-upgrade copy is taken before it |
| Financial totals change | Calculations untouched. Test: a schema-1 database upgraded → identical daily, monthly, location, payment and settlement figures |
| Visit creation refactor | `addVisit` was split into build + commit, and the existing 26 financial tests still pass unchanged |
| Old backups | Format 1 accepted, test included |
| Another tab still on the old version | The upgrade is blocked with a clear message ("close other tabs") instead of failing silently |
| Forgotten password locks clinical data | Recovery code (shown once at setup); financial data is never locked by encryption |

## 4. Database extensions

Every record has a stable random ID with a prefix: `PT-` patient, `E-` encounter, `VT-` vital, `DX-` diagnosis, `IN-` investigation, `F-` file, `RX-` prescription, `NV-` note version, `U-` user, `CA-` clinical audit. Records also carry `createdAt`/`updatedAt`. Nothing clinical is deleted: records are voided, cancelled, superseded or marked *entered in error*.

| Store | Holds | Links | At rest |
|---|---|---|---|
| `patients` | name, Hindi name, DOB or age (+ date recorded), sex, mobile, address, emergency contact, external IDs, registration date | — | clear (reception needs it) |
| `profiles` | alerts, clinical notes, "no known drug allergies" flag, history | patient | **encrypted** |
| `allergies` | substance, reaction, severity, status (active / inactive / entered in error), history | patient | **encrypted** |
| `conditions` | medical (comorbidities), surgical, family, personal, lifestyle; onset, status (current / resolved / uncertain), complications, treatment, history | patient | **encrypted** |
| `medications` | medicines the patient **reports** taking; status, last verified date, history | patient | **encrypted** |
| `encounters` | date, time, type, workflow (quick / detailed), treating doctor, status (draft / finalized / amending / cancelled), complaints[], history, exam[], assessment, plan, advice, follow-up, notes | patient, visit?, session?, location | **encrypted** (links/status/date in clear) |
| `vitals` | one measurement per record: type, value(s), unit, context, source, time, flags, voided + reason | patient, encounter | **encrypted** |
| `diagnoses` | kind (primary / secondary / differential / comorbidity), name, code, certainty, severity, status, `reviewOf` | patient, encounter, earlier diagnosis | **encrypted** |
| `investigations` | name, category, ordered / performed / result dates, value, unit, reference range, interpretation, ordered by, history | patient, encounter? | **encrypted** |
| `files` | name, type (checked from content), size, SHA-256, category, uploaded by | patient, encounter?, investigation? | **encrypted** |
| `blobs` | the attachment bytes (AES-GCM), loaded only on demand | file | **encrypted** |
| `prescriptions` | items[] (drug, strength, dose, route, frequency, timing, duration, quantity, instructions, start/stop), status (draft / approved / superseded / cancelled), version, `supersedes`, approved by/at | patient, encounter | **encrypted** |
| `noteVersions` | signed note (composed) + full snapshot of the encounter and its records, version n, original/amendment, reason, signed by/at | patient, encounter | **encrypted** |
| `templates` | exam templates, prescription templates, medicine favourites, note layout & required documentation | — | clear (no patient data) |
| `users` | name, login, role, PBKDF2 verifier, wrapped data key (clinical users only), active | — | clear (no secrets) |
| `clinicalAudit` | who, role, when, action (view / create / update / sign / amend / cancel / upload / print / export / sign-in…), entity, IDs | patient | clear, **no clinical content** |
| `visits` (existing) | + optional `patientRecordId` | patient | unchanged otherwise |

Treatment plans and follow-up plans are parts of the encounter (`advice`, `followUp`). Chief complaints and examination findings are child arrays of the encounter. All of them are versioned with the encounter through `noteVersions`.

## 5. Clinical rules enforced by the store

- **No financial side effects.** Notes, diagnoses, reports, attachments and prescriptions create no visit, charge or payment. Starting a consultation asks how the fee is handled:
  - **Record fee now:** creates exactly one visit, atomically with the encounter.
  - **Already billed:** links an existing visit. A visit can have only one clinical record.
  - **No fee:** no financial record, optionally counted under a session.
- **Summary sessions keep working.** A consultation can be counted under a summary session with no charge. If it records an individual visit into a summary session, that session moves to reconciliation and is still counted once.
- **Independent cancellation.** Cancelling the consultation leaves the fee alone; the app then asks separately whether to cancel the fee too. Cancelling the fee leaves the clinical record alone.
- **Multiple encounters** per patient and per day are allowed.
- **Vitals:**
  - Physically impossible values are rejected, or saved only after explicit confirmation, which is flagged. Examples: systolic ≤ diastolic, SpO₂ > 100, 101 entered as °C, height in metres.
  - Values outside adult reference ranges are saved with a review flag. Adult ranges are never applied under 18.
  - A flag is never a diagnosis.
  - Readings are append-only; a mistake is voided with a reason and its value kept.
- **Examination:** every system starts as *Not examined*. Nothing becomes normal unless the doctor marks it. Templates fill only what they contain, and the app reminds the doctor to review.
- **Diagnoses:** certainty is chosen explicitly. Complaints, vitals and results are never turned into diagnoses. An earlier diagnosis is reviewed by a new record (`reviewOf`), never edited.
- **Investigations:** a recorded result cannot be changed; a repeat test is a new record. Attachments are only ever added.
- **Uploads:** PDF, JPEG, PNG and WebP only. The type is detected from the file's content, not its name, so e.g. HTML or SVG disguised as PDF is refused. Maximum 15 MB. Files are encrypted and stored in IndexedDB, never localStorage.
- **Prescriptions:** never generated. The doctor enters or picks each line and must approve it. Editing an approved prescription creates a new version, and the old one becomes *superseded* when the new one is approved. Reported medicines are a separate list, marked "verify" after 90 days or when unverified. Past courses are shown with their end date, never as current.
- **Sign-off:** signing stores a version with the composed note and a full snapshot. A signed consultation is read-only; corrections need an amendment with a reason, which produces version 2, 3… Earlier versions stay viewable.

## 6. Screens

- **Patients tab:** search by name, mobile, patient ID or OPD number; follow-ups due; register a patient. Registration warns about possible duplicates (same mobile, similar name plus similar age or same DOB) and never merges.
- **Patient profile:**
  - **Overview:** alerts, allergies (unknown ≠ none), active problems, medical/surgical/family/personal/lifestyle history, details.
  - **Timeline:** filters by date, location, diagnosis and type; each consultation shows location, doctor, complaints, diagnoses, vitals, Rx and follow-up.
  - **Vitals:** trend per measure plus a table with flags.
  - **Reports:** history per test, trend, attachments.
  - **Medicines:** reported vs prescribed.
  - **Visits & fees:** read-only view of the financial ledger.
- **New consultation:** patient, date/time, location, session, type, treating doctor, quick or detailed, and fee handling.
- **Consultation:**
  - Patient banner with allergies, alerts, known problems and reported medicines.
  - Complaints (common-complaint chips, autocomplete, free text; detailed mode adds onset, progression, severity, associated symptoms, negatives).
  - History (detailed mode).
  - Vitals (quick grid, multiple timed readings, BMI).
  - Examination (per system; custom sections; templates).
  - Investigations with uploads.
  - Diagnoses and assessment.
  - Treatment (favourites, templates, approval).
  - Advice, follow-up (interval chips → date), notes.
  - The draft autosaves.
- **Note:** preview, print, export (HTML) and copy as text. Shows the version history of signed notes. The layout is set under *More → Clinical note & templates*: standard or SOAP, letterhead, sections, and which documentation counts as required.
- **Home:** financial metrics as before, plus clinical metrics: signed today and this month, pending notes, follow-ups due, missing documentation, and visits without a clinical record.
- **More → Security & users:** accounts, auto-lock time, a new recovery code, the clinical access log, and change password.

Hindi works in every text field, and the existing Hindi-labels option still applies.

## 7. Security, privacy and backup

**Accounts and roles.** Clinical records are switched on by creating the first doctor account. From then on everyone signs in. Before that, the app behaves exactly as before for the single owner.

| | Doctor | Receptionist | Staff / nurse |
|---|---|---|---|
| Register / edit patient details | ✓ | ✓ | ✓ |
| Visits, fees, patient payments | ✓ | ✓ | — |
| Hospital agreements, settlements, income reports, backup | ✓ | — | — |
| Read clinical notes, diagnoses, prescriptions | ✓ | — (no key) | — |
| Record vitals, attach reports | ✓ | — | only if allowed |
| Sign, amend, approve prescriptions, export notes | ✓ | — | — |
| Manage accounts | ✓ | — | — |

**Encryption at rest.**
- Clinical content and attachments are encrypted with AES-GCM-256 under one random data key. Only links, dates and status are stored in clear, which is what lets counts like *pending notes* work.
- The data key exists only wrapped: under each clinical user's password (PBKDF2-SHA-256, 310,000 iterations) and under the recovery code.
- **A receptionist account holds no copy of the key**, so clinical content is cryptographically unreadable to it, not merely hidden.
- Staff allowed to record vitals do hold the key; their limitation to vitals and reports is enforced by the app.
- Passwords are never stored. Five wrong attempts trigger an increasing delay.

**Sessions.**
- Auto-lock after 5, 10 (default), 15 or 30 minutes idle, and when the app returns after that long in the background.
- *Lock* is always in the header.
- Locking drops the key and every decrypted record from memory.

**Audit.**
- Financial changes stay in `audit`, with patient identity redacted.
- Clinical sign-ins (including failed ones), views (at most one entry per record per 10 minutes), changes, sign-offs, amendments, uploads, prints and exports go to `clinicalAudit`. It holds metadata only, no clinical text.

**Export controls.**
- Printing and exporting a note needs the doctor role, asks for confirmation (the file is readable health data) and is logged.
- Reports and CSV exports never contain clinical content.

**Uploads.** Types are checked from content, files are encrypted, a SHA-256 is recorded, and they're previewed through blob URLs. HTML and SVG (scriptable formats) are refused. The page's Content-Security-Policy blocks third-party scripts, and the app makes no network calls.

**Backups.** A backup contains clinical records and attachments **still encrypted**, plus the wrapped keys. It can be opened clinically only with a doctor's password or the recovery code from this practice, so keeping it on Google Drive or in email does not expose notes. Restore verifies the checksum and relationships, keeps a safety copy, and asks everyone to sign in again.

**Limits — please read.**
- Data lives **only on this device** and is not synchronised. Losing or resetting the phone, uninstalling the browser, or clearing site data deletes everything not in a backup. Keep backups off the phone.
- If the doctor password **and** the recovery code are both lost, the clinical records cannot be recovered by anyone. Financial records are not encrypted and remain usable.
- Patient demographics and financial records are protected by the sign-in, not by encryption. Someone with full access to an unlocked phone and developer tools could read them. Use the phone's own screen lock.
- There is no server, so there is no remote wipe and no central audit. Multi-device sync would need a backend with authentication, TLS, server-side authorization and conflict handling. It is not faked here.

## 8. Tests

`npm test` runs 42 tests: the 26 existing financial tests plus 16 new ones in `tests/clinical.test.js`.

| Requirement | Test |
|---|---|
| Existing reports unchanged after migration | schema-1 DB → upgrade → identical daily/monthly/location/payment/settlement figures; pre-upgrade copy present |
| Clinical encounter does not duplicate a financial visit | notes, diagnosis change, report, upload, prescription → zero new visits, payments or allocations; "record fee now" creates exactly one |
| Multiple encounters per patient (same day) | 3 encounters, separate vitals |
| Historical records accessible / note versions | sign → amend → v1 text preserved, v2 differs |
| Reports attach to the right patient and encounter | cross-patient attach refused; results never overwritten; attachments appended; disguised HTML refused; encrypted at rest |
| Previous vitals and diagnoses not overwritten | void keeps value; impossible values rejected; paediatric ranges; diagnosis review keeps the earlier record |
| Prescription edits keep history | approved → new version → superseded; note shows only the current version |
| Unauthorized staff cannot read restricted records | receptionist: no key, no clinical content in memory, writes refused; staff: vitals only; settlements doctor-only |
| Backups restore clinical and financial data | backup holds no plaintext; restore → sign in → same records and files; recovery code works |
| Summary sessions without clinical records; linking later without double counting | ✓ |
| Independent clinical / financial cancellation | ✓ |
| Duplicate warnings, never merged | ✓ |
| Note contains only what was recorded | unexamined systems are not "normal"; allergy status unknown ≠ none |
| Audit log redacts patient identity | ✓ |

`npm run test:e2e` runs 5 browser tests (Chromium, phone-sized). They include a full consultation with a rejected implausible BP, sign-off and note content, and a receptionist account that can bill but sees no clinical content.
