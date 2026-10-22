# Doctracker

A consultation and income tracker for a consultant physician who works across several hospitals, a personal clinic and village OPDs. It is an installable, offline Progressive Web App (Android, desktop, tablet). It records:

- **patients seen**, per location (new and follow-up)
- **consultation revenue** generated
- **money actually collected** (cash / UPI / bank / other)
- **what each hospital owes you** under its salary or revenue-share agreement
- whether summary and individual records **reconcile**

You can enter a whole OPD as a quick summary ("18 new, 9 follow-ups, ₹4,200 cash"), enter patients one by one, or do both and reconcile them.

**Clinical records (optional):** patient profiles, consultations (complaints, vitals, examination, diagnoses, investigations with report uploads, prescriptions, advice, follow-up), signed and amendable consultation notes, and a longitudinal timeline per patient. They are encrypted on the device, with doctor / receptionist / staff accounts. They are linked to visits but never create or change fees.

**Prescription scanner:** photograph or upload a handwritten prescription. AI reading (optional, cloud) or manual entry turns it into structured fields, which you review beside the image and approve one by one before anything enters the record. Medicines are never turned into a prescription.

Design, database schema, calculation rules and test plan: [docs/DESIGN.md](docs/DESIGN.md). Clinical upgrade (migration, schema, security): [docs/CLINICAL.md](docs/CLINICAL.md). Prescription scanner: [docs/SCANNER.md](docs/SCANNER.md).

## Using it

1. Open the app (see *Deployment*). On first run, choose **Start with example locations** and then edit names and fees under **More → Locations & fees**. You can also **Import from the old tracker**, or explore **demo mode** first.
2. For each hospital, set its **agreement** under **Money → Hospitals** (salary, %, minimum guarantee, which revenue it applies to, settlement frequency).
3. Daily: **Add → Quick session summary** or **Individual patient entry**.
4. Monthly: **Money → Hospitals → New settlement period**. Check the calculation, enter the hospital's figure if your agreement uses one, finalise, and record the payment when it arrives.
5. Clinical records: **More → Set up clinical records & sign-in**. Create your doctor account and write down the recovery code on paper. Then add receptionist or staff accounts under **More → Security & users**. Use **Patients** to register patients and **+ Consultation** to document a visit.
6. **Back up** regularly (**More → Backup & restore**). The header warns when there are changes that are not backed up yet. Keep the backup file **off the phone** (Google Drive, email to yourself, a computer).

> **Your data is stored only in this browser on this device.** It is not synchronised. To move to another phone, back up on the old one and restore on the new one. Clearing the browser's site data deletes it, so keep backups. Clinical records stay encrypted inside backups. Without the doctor password **or** the recovery code they cannot be opened by anyone, including you.

**Upgrading from the previous version:** nothing to do. On first start the app keeps a copy of your existing records on the device, adds the new storage, and asks you to make a fresh backup. Your financial data and reports are unchanged.

Suggestion: run it alongside your current register for at least two weeks before relying on it for monthly income.

## Install on your phone

Open the app's address in **Chrome on Android**, then use ⋮ → **Install app** (or **Add to Home screen**). It then opens full-screen and works with no internet. On iPhone: Safari → Share → **Add to Home Screen**.

## Setup (development)

Requires Node.js 20+ (only for tests and the local server; the app itself has no build step and no runtime dependencies).

```bash
npm install          # dev-only: fake-indexeddb, playwright-core (for tests)
npm start            # http://localhost:8080
npm test             # unit + integration tests
npm run test:e2e     # browser tests (needs Chromium; set CHROMIUM_PATH if not auto-detected)
npm run icons        # regenerate PNG icons
npm run vendor:sdk   # rebuild vendor/anthropic-sdk.mjs after changing the pinned SDK version
npm run ocr:eval -- <folder>   # measure handwriting accuracy on your own prescriptions (needs ANTHROPIC_API_KEY)
```

The app is plain ES modules. Open `index.html` through any static web server. Service workers and IndexedDB need `http://localhost` or `https://`, not `file://`.

## Deployment (GitHub Pages)

1. Merge to `main`.
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
3. The app is served at `https://<user>.github.io/doctracker/`. All paths are relative, so any static host or sub-folder works (Netlify, Cloudflare Pages, your own server). HTTPS is required for installation and offline use.
4. On each release, bump `VERSION` in `sw.js` so installed apps fetch the new files.
5. Serve over HTTPS only (GitHub Pages does). The page's Content-Security-Policy allows no third-party scripts.

The previous single-page tracker is kept as [`legacy.html`](legacy.html). Its data (browser localStorage on the same site) is untouched and can be imported from **More → Import from old tracker**.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `css/app.css`, `manifest.webmanifest`, `sw.js`, `icons/` | App shell, styles, install manifest, offline cache |
| `js/store.js` | All validated and audited operations (one IndexedDB transaction each) |
| `js/calc.js`, `js/reports.js`, `js/insights.js` | Pure financial calculations, reports, dashboard |
| `js/db.js` | IndexedDB adapter (plus an in-memory adapter for tests) |
| `js/backup.js` | Full export with checksum, verification, restore with safety copy |
| `js/legacy.js` | Import from the old tracker |
| `js/demo.js` | Example locations and demo data (separate demo database) |
| `js/clinical.js`, `js/clinical-store.js` | Clinical rules and operations (patients, encounters, vitals, diagnoses, investigations, prescriptions, sign-off) |
| `js/crypto.js`, `js/auth.js` | Encryption of clinical data, accounts, roles, recovery |
| `js/ocr/`, `js/scan-store.js`, `vendor/` | Prescription scanner: image clean-up, reading contract, medicine catalogue, review/import rules, bundled Anthropic SDK |
| `js/ui/` | Screens |
| `tests/` | `required.test.js` (the 14 acceptance tests), `units.test.js`, `clinical.test.js`, `scan.test.js`, `e2e/` |
