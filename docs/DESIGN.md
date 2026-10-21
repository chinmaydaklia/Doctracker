# Doctracker — design

A private, offline-first PWA for a consultant physician working at several hospitals, a personal clinic and village OPDs. It answers five questions at any time:

1. How many patients did I see, at each location?
2. How much consultation revenue did I generate?
3. How much did I actually collect?
4. How much does each hospital owe me?
5. Do my daily and monthly records reconcile?

## 1. Architecture and technology choices

| Choice | Why |
|---|---|
| **Static PWA, no build step.** Plain ES modules, HTML and CSS. | Nothing to compile, so it is easy to host (GitHub Pages) and easy to audit. It runs on Android Chrome, desktop browsers and tablets. |
| **IndexedDB** (`doctracker` database; `doctracker-demo` for demo data) | Reliable, transactional storage in the browser that survives app restarts. `navigator.storage.persist()` asks the browser not to evict it. |
| **In-memory model + atomic writes** | On start, every record is loaded into memory. Each user action becomes one IndexedDB transaction: the records, their audit-log entry and the "last change" marker. Memory is updated, and "Saved" shown, only after that transaction commits. Calculations stay instant (tens of thousands of visits are fine). |
| **Pure calculation core** (`js/calc.js`, `js/reports.js`, `js/insights.js`) | Every figure on every screen and report comes from the same pure functions over the record arrays, and those functions are unit-tested. |
| **Service worker** (`sw.js`) | Caches the app shell so the app opens and works with no network. It never caches data. |
| **No backend, no sync** | Data is **local to one browser on one device**. The app says so in the header ("Local only"). Moving devices = backup + restore. Multi-device sync would need an authenticated backend with conflict handling. That is deliberately not faked with local storage. |
| **Strict Content-Security-Policy** | Scripts and styles load only from the app's own origin. There are no third-party scripts, no analytics and no network calls. |

```
index.html ─ js/app.js (boot, router, header status)
              ├─ js/ui/*.js        screens (DOM only, call the store)
              ├─ js/store.js       validated, audited operations → one transaction each
              │    └─ js/db.js     IndexedDB adapter (memory adapter for tests)
              ├─ js/calc.js        ledger: visit/session totals, counted payments, settlements
              ├─ js/reports.js     report tables
              ├─ js/insights.js    dashboard figures
              ├─ js/backup.js      export / verify / restore
              └─ js/legacy.js      import from the old single-page tracker
```

## 2. Database schema

Every record has a stable random `id` with a type prefix. A session ID also carries the date, location and session, for example `S-20261021-HAICU-MOR-7K2Q9M`. A visit ID looks like `V-20261021-X3T9ZQ7A`. Patient names are never keys or IDs. **Money is an integer number of paise** everywhere. **Percentages are integer basis points** (30% = 3000).

| Store | Key fields | Relationships / notes |
|---|---|---|
| `locations` | `name`, `nameHi`, `kind`, `arrangement` (`direct` / `hospital` / `mixed`), `payerId`, `active`, `sortOrder` | `payerId` → `payers` (required unless direct). Deactivated, never deleted. |
| `rates` | `locationId`, `effectiveFrom`, `categories[]` = `{key, label, feePaise, isVisit}` | Rate history per location. `new` and `followup` are always present. Extra visit categories are configurable. `isVisit:false` covers items that are not consultations. |
| `payers` | `name`, `active` | A hospital that collects fees and/or pays a salary or share. |
| `agreements` | `payerId`, `effectiveFrom`, `type`, `salaryPaise`, `minPaise`, `pctBp`, `base`, `frequency`, `dueAfterDays` | Effective-dated. The one in force at a settlement period's start applies. |
| `sessions` | `date`, `locationId`, `sessionName`, `mode` (`summary` / `individual` / `summary_recon`), `collector` (`me` / `hospital`), `summary{lines[], grossOverridePaise, discountPaise}`, `status` (`open` / `needs_recon` / `reconciled`), `recon{source, note, at, by, items}` | One OPD/round at one location. |
| `visits` | `sessionId`, `date`, `locationId`, `patientId?`, `patientName?`, `category`, `categoryLabel`, `isVisit`, `standardFeePaise`, `feePaise`, `overrideReason`, `cancelled`, `voided` | The fee is **snapshotted** when the visit is recorded, so later rate changes never alter it. |
| `payments` | `date`, `kind` (`payment` / `refund`), `payerType` (`patient` / `hospital`), `payerId`, `locationId`, `method`, `amountPaise`, `reference`, `origin` (`summary` / `entry` / `import`), `sessionId`, `advance`, `voided` | Money actually received (or refunded). |
| `allocations` | `paymentId`, `targetType` (`visit` / `session` / `settlement`), `targetId`, `amountPaise` | Which balance a payment pays. The sum is ≤ the payment; any remainder must be flagged `advance`. |
| `adjustments` | `targetType`, `targetId`, `type` (`discount` / `waiver` / `correction` / `cancellation` / `settlement`), `amountPaise`, `reason`, `voided` | Separate, auditable transactions. Discounts and waivers are positive and reduce the fee. A correction or settlement adjustment is signed. |
| `settlements` | `payerId`, `periodStart`, `periodEnd`, `dueDate?`, `reportedBasePaise?`, `manualAmountPaise?`, `finalized{at, by, calc}` | Hospital settlement periods. Overlapping periods for one hospital are refused. |
| `audit` | `at`, `user`, `action`, `entity`, `entityId`, `reason`, `before`, `after` | Written in the same transaction as the change. Patient name and ID are redacted. |
| `backups` | `at`, `kind`, `counts`, `checksum`, `fileName`, `verified` | Backup and restore history. |
| `meta` | `settings` (user name, Hindi, last location/session), `backup` (`lastBackupAt`, `lastChangeAt`, `lastVerifiedAt`) | |
| `snapshots` | full backup object | Automatic safety copy made before each restore (last 3 kept). Not exported. |

User accounts: none in this version, because there is no backend. The "who" in the audit log is the name set in More → Preferences.

## 3. Screens and navigation

The bottom navigation has six tabs: **Home · Add · Sessions · Money · Reports · More**.

- **Home (dashboard)**: patients today and this month (new / follow-up); consultation revenue today and this month; patient collections today and this month by method; hospital payments received; total received; outstanding patient balances; outstanding hospital settlements (and how many are overdue); expected personal earnings this month, broken down by source; sessions needing reconciliation; locations with the highest volume and income. Each measure is labelled as revenue, collection, receivable or earnings.
- **Add** offers two choices: *Quick session summary* or *Individual patient entry*, plus recent sessions.
  - **Quick session summary**: date (defaults to today, shown as DD-MM-YYYY), location (remembers the last one), session (morning / afternoon / evening / custom), who collects (for mixed locations), mode, then one line per category with fee × count (+/− steppers), an optional manual gross total, discounts, collections by cash / UPI / bank / other with one-tap "All cash" and "All UPI", the computed unpaid amount, and remarks.
  - **Individual patient entry**: the same context, or fixed to a session. Patient ID and name are optional. Visit type buttons, the fee loaded from the location's rates (changing it asks for a reason), discount or waiver with a reason, a computed net fee, and payment as paid in full / part / unpaid with method, date and reference, plus remarks. **Save & next patient** keeps the context, so a whole OPD can be entered quickly.
- **Sessions**: sessions grouped by date, with filters and "needs reconciliation only". The **session detail** shows its totals, which source is counted, the reconciliation table and actions, its visits and its payments. Tapping a visit lets you record a payment, add a discount or waiver, correct it, refund, cancel or void it.
- **Money** has three parts:
  - Patient balances: each outstanding visit or summary session. You can receive one, several together, or record an advance.
  - Payments: everything received, with a reversal (void) for entries made by mistake.
  - Hospitals: each hospital's agreement (with history) and its settlement periods. A settlement shows its calculation, lets you enter the hospital-reported base or a manual amount, add adjustments (TDS etc.), record hospital payments, and finalise or unlock it.
- **Reports**: Daily, Monthly, Location-wise, Payments, Hospital settlements and Reconciliation. Filters: date range with quick Today / This month / Last month / FY buttons, location, hospital and session. Each report exports to CSV (opens in Excel) and prints.
- **More**: locations and fees (fee history, new fees from a date), hospitals and agreements, backup and restore, audit log, import from the old tracker, preferences (name, Hindi labels), and demo mode.

URLs carry only the screen name (`#session`). Record IDs and patient data never appear in the address bar.

## 4. Financial calculation rules

All of these are implemented in `js/calc.js`.

- **Gross fees** = sum of `feePaise` of genuine visits. Cancelled and voided visits are excluded. For summary-sourced sessions, gross = Σ count × fee, or the manually entered total.
- **Net fees** = gross − discounts − waivers ± corrections.
- **Patient visits** = number of genuine visit records in visit categories (summary: the counts). Payments and admissions are not visits. One patient can have any number of genuine visits, including on the same day. A repeated patient ID in the same session asks for confirmation and is never auto-rejected.
- **Collection for a date** = sum of counted patient payments dated that day, minus refunds dated that day. A later payment for an earlier visit is a collection of the later date and **never** new consultation revenue.
- **Outstanding (patient)** = net fees − payments allocated to those visits or sessions. This applies only where the patient pays me (`collector = me`). Hospital-collected fees never create a patient balance.
- **Allocations** cannot exceed what is outstanding. An unallocated remainder must be explicitly marked as an advance (shown as such, counted as a collection on its date).
- **Refunds** are negative payments allocated to a visit. **Cancellations** set the visit as not genuine and record a cancellation adjustment. Money already paid shows as "refund due" until refunded. **Voids** mark a record entered by mistake. Records with money attached cannot be voided until the money is reversed. Nothing financial is ever hard-deleted.
- **Patient receivable at a date** = cumulative net fees of direct sessions up to that date − cumulative counted patient payments up to that date. Monthly reports use this at each month end.

### Payment arrangements and hospital settlements

- `direct`: patients pay me. `hospital`: the hospital collects and settles with me later. `mixed`: chosen per session. Patient and hospital ledgers never mix. Hospital payments are allocated only to settlement periods.
- **Eligible revenue** for a hospital and period = gross or net fees of sessions **collected by that hospital** at its locations in the period. The base can instead be hospital-reported collections or another defined base, entered on the settlement.
- **Agreement amount** for the period (salary and minimum are per settlement period):
  1. fixed: `salary`
  2. pct: `base × pct`
  3. min: `minimum`
  4. max_min_pct: `MAX(minimum, base × pct)`
  5. min_plus_pct: `minimum + base × pct`
  6. salary_plus_pct: `salary + base × pct`
  7. manual: the entered amount

  Percentages are rounded half away from zero to the nearest paisa.
- **Total payable** = agreement amount + settlement adjustments (signed, e.g. TDS −10%). **Balance** = total payable − hospital payments allocated to it. **Status** is paid, part paid, unpaid, or overdue once past the due date (period end + `dueAfterDays`).
- A settlement stays **provisional** (it recalculates from your records) until **finalised**. Finalising snapshots the calculation. If records change later, the settlement shows the drift instead of changing silently.
- The settlement screen always displays the agreement in force and its formula. A percentage is never applied without the configured agreement being shown.
- **Expected earnings (dashboard)** = net fees of my directly collected sessions + each hospital's amount: from its settlement record if one covers the month, otherwise an estimate from its agreement for the calendar month.

## 5. Reconciliation workflow

A session is counted from **one source only**: its summary or its individual visits, never both.

| Mode | What is counted |
|---|---|
| `summary` (summary only) | summary figures |
| `individual` | individual visits |
| `summary_recon`, not yet reviewed | summary figures, **provisionally**. The session shows "Needs reconciliation". |
| `summary_recon`, reconciled | the source the user chose: individual records (default) or summary figures |

1. Adding an individual visit to a summary session switches it to `summary_recon` / `needs_recon`.
2. The session screen compares summary and individual figures: new, follow-up, total visits, gross, discounts, net, payments received on the session day, and outstanding. It shows the difference for each (for example 30 vs 29 patients = −1, ₹9,000 vs ₹8,700 = −₹300).
3. The user marks it reconciled. "Individual records are correct" makes the individual records the source of truth for every report. "Keep summary figures" keeps the summary, for example when a slip is missing. If the figures differ, a reason is required.
4. A summary-only session can simply stay summary-only.
5. Reopening needs a reason and is written to the audit log. Changing visits or the summary after reconciliation reopens it automatically, also logged.
6. Payment handling:
   - Summary collections are stored as payments with `origin = summary`. They count only while the summary is the source.
   - Visit payments on the session day are the detail of those same collections. They count only when individual records are the source.
   - Payments dated after the session day are new money and always count.
7. Duplicate prevention: creating a second session with the same date, location and session name asks for confirmation. Nothing is declared a duplicate automatically on date, location, fee or patient ID alone.

## 6. Security, privacy and backup

- Patient identity is optional (ID and/or name). There are no diagnosis, address or history fields. Patient fields are redacted from the audit log. No patient data goes in URLs, logs, analytics or the network (there is no network use at all).
- Every change records who (the configured name), when, what changed (before/after) and why. Corrections, voids, reopenings, cancellations, refunds and fee edits require a reason.
- Destructive actions (void, cancel, restore, erase demo) need confirmation.
- **Backups**: *Back up now* exports every record in a JSON file with record counts and a SHA-256 checksum. The file is verified (re-parsed, checksum checked, relationships checked) before the backup is recorded. On Android it can be shared straight to Google Drive, email or another app.
- **Verify** checks any backup file without changing data. **Restore** verifies first, shows what will be replaced, asks for confirmation, and keeps a safety copy of the current data on the device.
- The header always shows "Saved on this device" (or a red warning if the browser blocked storage), the backup state ("Never backed up", "Backup 3d old", "✓ Backed up") and "Local only".
- Demo data lives in a separate database, with a purple banner, a purple header and `DEMO` in file names.

## 7. Test plan

`npm test` runs the unit and integration tests (Node test runner, in-memory and fake IndexedDB):

| # | Requirement | Test |
|---|---|---|
| 1 | 10 new × ₹300 + 5 follow-ups × ₹150 = 15 visits, ₹3,750 | `required.test.js` #1 (summary and individual) |
| 2 | ₹300 visit, ₹200 received → ₹100 outstanding | #2 |
| 3 | Later ₹100 changes collections and outstanding only | #3 (plus over-allocation rejected) |
| 4 | ₹50 waiver on ₹300 → ₹250 | #4 (at entry and as a later adjustment) |
| 5 | Unpaid visit → no collection | #5 |
| 6 | Hospital settlement payment reduces hospital balance only | #6 (MAX and minimum-plus-percentage) |
| 7 | No double counting of summary + individual | #7 |
| 8 | Discrepancy flagged | #8 (30 vs 29, ₹9,000 vs ₹8,700; reason required; reopen logged) |
| 9 | Rate edits don't change past visits | #9 |
| 10 | Two genuine visits by one patient allowed | #10 |
| 11 | Refunds and adjustments reconcile | #11 (refund, discount, cancellation, void, TDS) |
| 12 | Daily/monthly totals = transactions | #12 (cross-month payment, month-end receivable) |
| 13 | Export/restore preserve records & relationships | #13 (+ tampering and broken links detected), and e2e |
| 14 | Offline entries persist after closing/reopening | #14 (IndexedDB) and e2e (browser offline, closed and reopened) |

`units.test.js` covers paise parsing and Indian formatting, basis-point rounding, dates and financial years, all seven agreement types, CSV safety, duplicate warnings, PII redaction, the legacy import and the service-worker cache list. `npm run test:e2e` drives Chromium through first run, offline use, demo mode on every screen, reconciliation, settlements, and backup → verify → restore.
