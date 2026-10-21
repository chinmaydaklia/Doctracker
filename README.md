# Doctracker

A consultation and income tracker for a consultant physician who works across several hospitals, a personal clinic and village OPDs. It is an installable, offline Progressive Web App (Android, desktop, tablet). It records:

- **patients seen**, per location (new and follow-up)
- **consultation revenue** generated
- **money actually collected** (cash / UPI / bank / other)
- **what each hospital owes you** under its salary or revenue-share agreement
- whether summary and individual records **reconcile**

You can enter a whole OPD as a quick summary ("18 new, 9 follow-ups, ₹4,200 cash"), enter patients one by one, or do both and reconcile them.

Design, database schema, calculation rules and test plan: [docs/DESIGN.md](docs/DESIGN.md).

## Using it

1. Open the app (see *Deployment*). On first run, choose **Start with example locations** and then edit names and fees under **More → Locations & fees**. You can also **Import from the old tracker**, or explore **demo mode** first.
2. For each hospital, set its **agreement** under **Money → Hospitals** (salary, %, minimum guarantee, which revenue it applies to, settlement frequency).
3. Daily: **Add → Quick session summary** or **Individual patient entry**.
4. Monthly: **Money → Hospitals → New settlement period**. Check the calculation, enter the hospital's figure if your agreement uses one, finalise, and record the payment when it arrives.
5. **Back up** regularly (**More → Backup & restore**). The header warns when there are changes that are not backed up yet. Keep the backup file **off the phone** (Google Drive, email to yourself, a computer).

> **Your data is stored only in this browser on this device.** It is not synchronised. To move to another phone, back up on the old one and restore on the new one. Clearing the browser's site data deletes it, so keep backups.

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
```

The app is plain ES modules. Open `index.html` through any static web server. Service workers and IndexedDB need `http://localhost` or `https://`, not `file://`.

## Deployment (GitHub Pages)

1. Merge to `main`.
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
3. The app is served at `https://<user>.github.io/doctracker/`. All paths are relative, so any static host or sub-folder works (Netlify, Cloudflare Pages, your own server). HTTPS is required for installation and offline use.
4. On each release, bump `VERSION` in `sw.js` so installed apps fetch the new files.

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
| `js/ui/` | Screens |
| `tests/` | `required.test.js` (the 14 acceptance tests), `units.test.js`, `e2e/` |
