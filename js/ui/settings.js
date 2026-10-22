// More: locations & fees, backup/restore, demo data, old-tracker import, audit log, preferences.
import { h, add, clear, money, date, field, moneyInput, dateInput, segmented, select, toast, modal, askReason, attempt, badge, confirmDialog, downloadFile, readFileText } from "./dom.js";
import { setHindi } from "../i18n.js";
import { today, fmtDateTime } from "../dates.js";
import { ARRANGEMENTS, LOCATION_KINDS, DATA_STORES } from "../model.js";
import { agreementFor } from "../calc.js";
import { buildBackup, verifyBackup, restoreBackup, markBackedUp, restoreSnapshot, listSnapshots } from "../backup.js";
import { DEFAULT_REQUIRED } from "../clinical.js";
import { readLegacyLocalStorage, convertLegacy } from "../legacy.js";
import { seedExampleLocations, seedDemo } from "../demo.js";
import { describeAgreement } from "./money.js";

export function renderMore(app) {
  const store = app.store;
  const s = store.settings;
  const name = h("input", { type: "text", value: s.userName || "Doctor" });
  const item = (title, sub, go, perm) => (perm && !store.perms.includes(perm) ? null : h("button", { class: "choice", onclick: go }, h("b", null, title), h("span", null, sub)));
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "More"),
    app.migration && !s.upgradeNoticeSeen && store.perms.includes("backup")
      ? h("div", { class: "card warn" }, h("b", null, "App upgraded with clinical records."), h("p", { class: "small" }, "Your financial records were not changed, and a copy of them from before the upgrade is kept on this device. Make a fresh backup now."), h("button", { class: "btn primary small", onclick: () => store.saveSettings({ upgradeNoticeSeen: true }).then(() => app.go("backup")) }, "Back up now"))
      : null,
    store.authEnabled
      ? item("Security & users", store.session ? `Signed in as ${store.session.name} · accounts, auto-lock, access log` : "", () => app.go("users"))
      : item("Set up clinical records & sign-in", "Patient notes, vitals, diagnoses, prescriptions — encrypted on this device, with doctor / receptionist / staff accounts", () => app.go("security"), "users"),
    item("Clinical note & templates", "Note layout (standard or SOAP), required documentation, saved templates and favourites", () => app.go("clinicalSettings"), "clinical.write"),
    item("Locations & fees", `${store.data.locations.filter((l) => l.active).length} active locations · fee history`, () => app.go("locations"), "finance.admin"),
    item("Hospitals & agreements", "Salary, revenue share, minimum guarantee, settlement periods", () => app.go("money", { tab: "hospitals" }), "finance.admin"),
    item("Backup & restore", backupLine(store), () => app.go("backup"), "backup"),
    item("Audit log", "Every financial change: who, when, why", () => app.go("audit"), "backup"),
    item("Import from old tracker", "Bring in entries from the earlier version of this app", () => app.go("importOld"), "finance.admin"),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Preferences"),
      store.authEnabled ? null : [field("Your name (recorded in the audit log)", name), h("button", { class: "btn small", onclick: () => attempt(() => store.saveSettings({ userName: name.value.trim() || "Doctor" })).then(() => toast("Saved ✓")) }, "Save name")],
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.showHindi, onchange: async (e) => { await store.saveSettings({ showHindi: e.target.checked }); setHindi(e.target.checked); location.reload(); } }), " Show Hindi labels (हिंदी)"),
    ),
    store.authEnabled && !store.perms.includes("backup") ? null : h(
      "div",
      { class: "card" },
      h("h3", null, app.mode === "demo" ? "Demo mode (separate database)" : "Demo data"),
      app.mode === "demo"
        ? [
            h("p", { class: "small" }, "You are looking at demo data stored separately from your real records."),
            h("div", { class: "row-btns wrap" }, h("button", { class: "btn primary", onclick: () => app.switchMode("real") }, "Back to my records"), h("button", { class: "btn", onclick: () => loadDemo(app) }, "Load sample data"), h("button", { class: "btn danger-o", onclick: () => eraseDemo(app) }, "Erase demo data")),
          ]
        : [h("p", { class: "small" }, "Try the app with realistic sample data. It lives in a separate demo database and never mixes with your records."), h("button", { class: "btn", onclick: () => app.switchMode("demo") }, "Open demo mode")],
    ),
    h("p", { class: "muted small" }, "Doctracker v2 · data stored only on this device (IndexedDB)", app.persistent ? " · persistent storage granted" : " · browser may clear storage under pressure: keep backups", " · ", h("a", { href: "legacy.html" }, "old tracker")),
  );
}

function backupLine(store) {
  const b = store.backupMeta;
  if (!b.lastBackupAt) return "⚠ Never backed up";
  return "Last backup " + fmtDateTime(b.lastBackupAt) + (b.lastChangeAt > b.lastBackupAt ? " · changes since" : " · up to date");
}

async function loadDemo(app) {
  if (app.mode !== "demo") return;
  if (app.store.data.sessions.length && !(await confirmDialog("Load sample data", "Add another set of sample data to the demo database?"))) return;
  toast("Creating demo data…");
  if (await attempt(() => seedDemo(app.store).then(() => true))) {
    toast("Demo data loaded ✓");
    app.go("home");
  }
}

async function eraseDemo(app) {
  if (app.mode !== "demo") return;
  if (!(await confirmDialog("Erase demo data", "Delete everything in the DEMO database? Your real records are not affected.", { ok: "Erase demo data", danger: true }))) return;
  const ops = DATA_STORES.map((s) => ({ store: s, clear: true }));
  await app.store.adapter.write(ops);
  await app.store.reload();
  app.go("welcome");
}

// ---------------------------------------------------------------- welcome

export function renderWelcome(app) {
  const legacy = app.mode === "real" ? readLegacyLocalStorage() : null;
  let busy = false;
  const go = async (fn) => {
    if (busy) return;
    busy = true;
    document.querySelectorAll("main .choice").forEach((b) => (b.disabled = true));
    toast("Setting up…");
    const ok = await attempt(fn);
    busy = false;
    if (ok) app.go("home");
    else document.querySelectorAll("main .choice").forEach((b) => (b.disabled = false));
  };
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Welcome to Doctracker"),
    h("p", null, "Track patients seen, consultation fees, money collected and what each hospital owes you — across all your locations, offline."),
    app.mode === "demo" ? h("div", { class: "card warn" }, "This is the separate DEMO database.") : null,
    legacy ? h("button", { class: "choice", onclick: () => app.go("importOld") }, h("b", null, `Import ${legacy.entries.length} entries from the old tracker`), h("span", null, "Found on this device. Your old data is not changed.")) : null,
    app.mode === "demo"
      ? h("button", { class: "choice", onclick: () => go(() => seedDemo(app.store).then(() => true)) }, h("b", null, "Load sample data"), h("span", null, "Six weeks of realistic entries, settlements and one session that needs reconciliation."))
      : null,
    h("button", { class: "choice", onclick: () => go(() => seedExampleLocations(app.store).then(() => true)) }, h("b", null, "Start with example locations"), h("span", null, "Hospital A ICU ₹400, private ward ₹300, general ward ₹200, OPDs, own clinic, village OPDs, camps. Rename and change every fee afterwards.")),
    h("button", { class: "choice", onclick: () => app.go("location", {}) }, h("b", null, "Add my first location"), h("span", null, "Start empty and set up locations and fees yourself.")),
    app.mode === "real" ? h("button", { class: "choice", onclick: () => app.switchMode("demo") }, h("b", null, "Explore with demo data first"), h("span", null, "Opens a separate demo database.")) : null,
    h("button", { class: "choice", onclick: () => app.go("backup") }, h("b", null, "Restore from a backup file"), h("span", null, "Moving from another phone or computer.")),
  );
}

// -------------------------------------------------------------- locations

export function renderLocations(app) {
  const store = app.store;
  const locs = store.locationsSorted({ includeInactive: true });
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Locations & fees"),
    h("button", { class: "btn primary", onclick: () => app.go("location", {}) }, "+ Add location"),
    locs.map((l) => {
      const r = store.currentRate(l.id);
      return h(
        "button",
        { class: "row click" + (l.active ? "" : " dim"), onclick: () => app.go("location", { id: l.id }) },
        h("div", null, h("b", null, l.name), h("div", { class: "muted small" }, ARRANGEMENTS[l.arrangement], l.payerId ? " · " + store.payerName(l.payerId) : "", l.active ? "" : " · inactive")),
        h("div", { class: "right small" }, r ? r.categories.map((c) => h("div", null, c.label, " ", money(c.feePaise))) : badge("No fees", "bad")),
      );
    }),
  );
}

function categoryEditor(cats) {
  const wrap = h("div");
  const draw = () => {
    clear(wrap);
    cats.forEach((c, i) => {
      const fee = moneyInput({ value: c.feePaise, oninput: () => (c.feePaise = fee.paise()) });
      const label = h("input", { type: "text", value: c.label, disabled: c.key === "new" || c.key === "followup", oninput: (e) => (c.label = e.target.value) });
      add(wrap, 
        h(
          "div",
          { class: "line cat" },
          label,
          fee,
          c.key === "new" || c.key === "followup" ? h("span") : h("label", { class: "check small" }, h("input", { type: "checkbox", checked: c.isVisit !== false, onchange: (e) => (c.isVisit = e.target.checked) }), " counts as visit"),
          c.key === "new" || c.key === "followup" ? h("span") : h("button", { type: "button", class: "link", onclick: () => { cats.splice(i, 1); draw(); } }, "remove"),
        ),
      );
    });
    add(wrap, h("button", { type: "button", class: "btn small", onclick: () => { cats.push({ key: "c" + Date.now().toString(36), label: "", feePaise: 0, isVisit: true }); draw(); } }, "+ Add visit category"));
  };
  draw();
  return wrap;
}

export function renderLocation(app, { id }) {
  const store = app.store;
  const loc = id ? store.get("locations", id) : null;
  const st = { kind: loc ? loc.kind : "hospital", arrangement: loc ? loc.arrangement : "direct", payerId: loc ? loc.payerId || "" : store.data.payers[0]?.id || "" };
  const name = h("input", { type: "text", value: loc ? loc.name : "", placeholder: "e.g. Hospital A — ICU" });
  const nameHi = h("input", { type: "text", value: loc ? loc.nameHi : "", placeholder: "optional", lang: "hi" });
  const payerBox = h("div");
  const drawPayer = () => {
    clear(payerBox);
    if (st.arrangement === "direct") return;
    const payers = store.data.payers.filter((p) => p.active !== false);
    add(payerBox, 
      field("Hospital that settles with you", select([{ value: "", label: "— choose —" }, ...payers.map((p) => ({ value: p.id, label: p.name }))], st.payerId, (v) => { st.payerId = v; drawPayer(); })),
      h("button", { type: "button", class: "btn small", onclick: async () => {
        const n = await askReason("New hospital", "Hospital name", { ok: "Add", placeholder: "Hospital name" });
        if (!n) return;
        const p = await attempt(() => store.savePayer({ name: n }));
        if (p) { st.payerId = p.id; drawPayer(); }
      } }, "+ New hospital"),
      st.payerId ? h("p", { class: "small muted" }, "Agreement: ", describeAgreement(agreementFor(store.data.agreements, st.payerId, today())), " ", h("button", { type: "button", class: "link", onclick: () => app.go("hospital", { id: st.payerId }) }, "edit")) : null,
    );
  };
  drawPayer();

  const cur = loc ? store.currentRate(loc.id) : null;
  const cats = structuredClone(cur ? cur.categories : [{ key: "new", label: "New patient", feePaise: 0, isVisit: true }, { key: "followup", label: "Follow-up", feePaise: 0, isVisit: true }]);
  const eff = dateInput(loc ? today() : "2020-01-01");
  const err = h("div", { class: "err" });

  const save = async () => {
    err.textContent = "";
    if (cats.some((c) => c.feePaise === null)) return (err.textContent = "Check the fee amounts.");
    const input = { id: loc?.id, name: name.value, nameHi: nameHi.value, kind: st.kind, arrangement: st.arrangement, payerId: st.payerId || null, active: loc ? loc.active : true };
    try {
      if (!loc) {
        await store.saveLocation(input, { effectiveFrom: eff.value, categories: cats });
        toast("Location added ✓");
        app.go("locations", {}, { replace: true });
        return;
      }
      await store.saveLocation(input);
      toast("Location saved ✓");
      app.render();
    } catch (e) {
      err.textContent = e.message;
    }
  };

  const rates = loc ? store.data.rates.filter((r) => r.locationId === loc.id && !r.voided).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)) : [];
  return h(
    "div",
    { class: "screen" },
    h("h1", null, loc ? loc.name : "New location"),
    h(
      "div",
      { class: "card" },
      field("Location name", name),
      field("Hindi name", nameHi),
      field("Type", select(Object.entries(LOCATION_KINDS).map(([value, label]) => ({ value, label })), st.kind, (v) => (st.kind = v))),
      field("Payment arrangement", segmented(Object.entries(ARRANGEMENTS).map(([value, label]) => ({ value, label })), st.arrangement, (v) => { st.arrangement = v; drawPayer(); })),
      payerBox,
      loc ? null : [h("h3", null, "Fees"), categoryEditor(cats), field("Fees effective from", eff)],
      err,
      h("div", { class: "row-btns" }, h("button", { class: "btn primary", onclick: save }, "Save"), loc ? h("button", { class: "btn", onclick: () => attempt(() => store.setLocationActive(loc.id, !loc.active)).then(() => app.render()) }, loc.active ? "Deactivate" : "Activate") : null),
    ),
    loc
      ? h(
          "div",
          { class: "card" },
          h("h3", null, "Fee history"),
          h("p", { class: "small muted" }, "Each visit keeps the fee it was recorded with. A new fee schedule applies from its effective date onward."),
          h("button", { class: "btn small primary", onclick: () => rateDialog(app, loc, cur, null) }, "New fees from a date"),
          rates.map((r) => h("div", { class: "row" }, h("div", null, h("b", null, "From ", date(r.effectiveFrom)), h("div", { class: "small" }, r.categories.map((c) => `${c.label} ${money(c.feePaise)}${c.isVisit ? "" : " (not a visit)"}`).join(" · ")), r.note ? h("div", { class: "small muted" }, r.note) : null), h("button", { class: "link small", onclick: () => rateDialog(app, loc, r, r) }, "edit"))),
        )
      : null,
  );
}

function rateDialog(app, loc, base, editing) {
  const cats = structuredClone(base ? base.categories : []);
  const eff = dateInput(editing ? editing.effectiveFrom : today());
  const note = h("input", { type: "text", value: editing ? editing.note : "", placeholder: "Note (optional)" });
  const err = h("div", { class: "err" });
  return modal(editing ? "Edit fee schedule" : "New fees", [editing ? h("p", { class: "small badc" }, "Editing a schedule does not change visits already recorded; they keep their own fee.") : null, categoryEditor(cats), field("Effective from", eff), note, err], [
    { label: "Cancel", result: false },
    {
      label: "Save fees",
      kind: "primary",
      value: async () => {
        try {
          if (cats.some((c) => c.feePaise === null)) throw new Error("Check the fee amounts.");
          if (editing) {
            const r = await askReason("Reason", "Why are you editing this fee schedule?");
            if (r === null) return undefined;
            await app.store.updateRate(editing.id, { effectiveFrom: eff.value, categories: cats, note: note.value }, r);
          } else await app.store.addRate({ locationId: loc.id, effectiveFrom: eff.value, categories: cats, note: note.value });
          toast("Fees saved ✓");
          app.render();
          return true;
        } catch (e) {
          err.textContent = e.message;
          return undefined;
        }
      },
    },
  ]);
}

// ------------------------------------------------------------------ backup

export function renderBackup(app) {
  const store = app.store;
  const b = store.backupMeta;
  const out = h("div", { class: "card hide" });
  const show = (kind, nodes) => {
    out.className = "card " + kind;
    add(clear(out), nodes);
  };
  const counts = store.counts();

  const doBackup = async () => {
    try {
      const backup = await buildBackup(store, { demo: app.mode === "demo" });
      const text = JSON.stringify(backup);
      // Verify the exact bytes being saved before calling it a backup.
      const v = await verifyBackup(JSON.parse(text));
      if (!v.ok) throw new Error("Backup verification failed: " + v.errors.join("; "));
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const fname = `doctracker-${app.mode === "demo" ? "DEMO-" : ""}backup-${stamp}.json`;
      const file = new File([text], fname, { type: "application/json" });
      let shared = false;
      if (navigator.canShare && navigator.canShare({ files: [file] }) && (await confirmDialog("Save backup", "Share the backup file to Google Drive, email or WhatsApp-to-self? Choose Cancel to download it to this device instead.", { ok: "Share" }))) {
        try {
          await navigator.share({ files: [file], title: fname });
          shared = true;
        } catch (e) {
          if (e.name === "AbortError") return;
        }
      }
      if (!shared) downloadFile(fname, file);
      await markBackedUp(store, { counts: v.counts, checksum: backup.checksum, fileName: fname, verified: true });
      show("ok", [h("b", null, "✓ Backup created and verified: " + fname), h("p", { class: "small" }, "Keep a copy OFF this phone (Google Drive, email to yourself, a computer). A backup on the same phone is lost with the phone.")]);
      app.renderStatus();
    } catch (e) {
      show("bad", [h("b", null, "Backup failed: "), e.message]);
    }
  };

  const fileInput = (onfile) => h("input", { type: "file", accept: "application/json,.json", onchange: async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onfile(f); } });

  const verifyFile = async (f) => {
    try {
      const v = await verifyBackup(JSON.parse(await readFileText(f)));
      show(v.ok ? "ok" : "bad", [h("b", null, v.ok ? "✓ Backup is complete and intact" : "✗ Problems found"), v.exportedAt ? h("p", { class: "small" }, "Exported " + fmtDateTime(v.exportedAt) + (v.demo ? " · DEMO data" : "")) : null, v.counts ? h("p", { class: "small" }, countsLine(v.counts)) : null, v.errors.length ? h("ul", null, v.errors.map((e) => h("li", null, e))) : null]);
      if (v.ok) await store.commit([{ store: "meta", put: { ...store.backupMeta, lastVerifiedAt: Date.now() } }], [], { dataChange: false });
    } catch (e) {
      show("bad", ["Could not read the file: ", e.message]);
    }
  };

  const restoreFile = async (f) => {
    try {
      const obj = JSON.parse(await readFileText(f));
      const v = await verifyBackup(obj);
      if (!v.ok) return show("bad", [h("b", null, "This file cannot be restored:"), h("ul", null, v.errors.map((e) => h("li", null, e)))]);
      if (v.demo && app.mode === "real" && !(await confirmDialog("Demo backup", "This backup contains DEMO data. Restore it into your real records anyway?", { danger: true, ok: "Restore demo data" }))) return;
      const oldFormat = v.format < 2 && (store.data.patients.length || store.authEnabled) ? "\n\n⚠ This is an older backup WITHOUT clinical records or accounts. Restoring it removes all patients, clinical records and sign-in accounts from this device (they stay in the safety copy)." : "";
      const ok = await confirmDialog("Replace all data?", `Restore the backup from ${fmtDateTime(v.exportedAt)}?\n\nIt contains ${countsLine(v.counts)}.\n\nEverything currently on this device (${countsLine(counts)}) will be replaced. A safety copy of the current data is kept on this device.${oldFormat}\n\nAfter restoring, sign in with an account from the backup.`, { ok: "Replace and restore", danger: true });
      if (!ok) return;
      await restoreBackup(store, obj);
      toast("Restored ✓ — sign in again");
      await app.lock();
      app.go("home");
    } catch (e) {
      show("bad", ["Restore failed: ", e.message]);
    }
  };

  const snapBox = h("div");
  listSnapshots(store).then((snaps) => {
    if (!snaps.length) return;
    add(snapBox, h("div", { class: "card" }, h("h3", null, "Safety copies on this device"), h("p", { class: "small muted" }, "Made automatically before each restore and before the database upgrade."), snaps.map((s) => h("div", { class: "row" }, h("div", null, fmtDateTime(s.at), " · ", s.reason), h("button", { class: "btn small", onclick: async () => { if ((await confirmDialog("Restore safety copy", "Replace current data with this safety copy? (The current data is saved as another safety copy first.)", { danger: true, ok: "Restore" })) && (await attempt(() => restoreSnapshot(store, s.id).then(() => true)))) { await app.lock(); app.go("home"); } } }, "Restore")))));
  });
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Backup & restore"),
    h(
      "div",
      { class: "card" },
      h("div", { class: "kv" }, h("span", null, "Last backup"), h("b", null, b.lastBackupAt ? fmtDateTime(b.lastBackupAt) : "never")),
      h("div", { class: "kv" }, h("span", null, "Last change"), h("b", null, b.lastChangeAt ? fmtDateTime(b.lastChangeAt) : "—")),
      h("div", { class: "kv" }, h("span", null, "Last verified"), h("b", null, b.lastVerifiedAt ? fmtDateTime(b.lastVerifiedAt) : "—")),
      h("div", { class: "kv" }, h("span", null, "Status"), h("b", null, !b.lastBackupAt ? "⚠ never backed up" : b.lastChangeAt > b.lastBackupAt ? "⚠ changes not backed up" : "✓ up to date")),
      h("p", { class: "small" }, countsLine(counts)),
      h("p", { class: "small muted" }, "Data is stored only in this browser on this device. It is not synchronised to other devices. To move to another device, back up here and restore there."),
      store.authEnabled ? h("p", { class: "small muted" }, "Clinical records and attachments stay encrypted inside the backup file; they can only be opened with a doctor's password or the recovery code from this practice.") : null,
      h("button", { class: "btn primary big", onclick: doBackup }, "⬇ Back up now (full data)"),
    ),
    out,
    h("div", { class: "card" }, h("h3", null, "Verify a backup file"), h("p", { class: "small muted" }, "Checks the checksum, record counts and every relationship, without changing anything."), fileInput(verifyFile)),
    h("div", { class: "card" }, h("h3", null, "Restore from backup"), h("p", { class: "small muted" }, "Replaces all data on this device after verification and confirmation."), fileInput(restoreFile)),
    snapBox,
  );
}

function countsLine(c) {
  const clin = c.patients || c.encounters ? `, ${c.patients || 0} patients, ${c.encounters || 0} consultations, ${c.files || 0} attachments (encrypted)` : "";
  return `${c.sessions || 0} sessions, ${c.visits || 0} visits, ${c.payments || 0} payments, ${c.locations || 0} locations, ${c.settlements || 0} settlements${clin}, ${c.audit || 0} audit entries`;
}

// -------------------------------------------------------------------- audit

export function renderAudit(app) {
  const store = app.store;
  const rows = [...store.data.audit].sort((a, b) => b.at - a.at).slice(0, 300);
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Audit log"),
    h("p", { class: "small muted" }, "Latest 300 of ", store.data.audit.length, " entries. Patient names and IDs are not written to the log."),
    rows.map((a) => h("details", { class: "row audit" }, h("summary", null, h("b", null, a.action, " ", a.entity), " · ", fmtDateTime(a.at), " · ", a.user, a.reason ? h("div", { class: "small" }, "Reason: ", a.reason) : null, h("div", { class: "small muted" }, a.entityId)), a.before ? h("pre", { class: "small" }, "Before: ", JSON.stringify(a.before, null, 1)) : null, a.after ? h("pre", { class: "small" }, "After: ", JSON.stringify(a.after, null, 1)) : null)),
  );
}

// ---------------------------------------------------------------- old import

export function renderImportOld(app) {
  const store = app.store;
  const out = h("div");
  const preview = (legacy, source) => {
    clear(out);
    let conv;
    try {
      conv = convertLegacy(legacy, { now: Date.now(), today: today() });
    } catch (e) {
      add(out, h("p", { class: "err" }, "Could not read the old data: " + e.message));
      return;
    }
    const visits = conv.sessions.reduce((t, s) => t + s.summary.lines.filter((l) => l.isVisit).reduce((x, l) => x + l.count, 0), 0);
    const already = store.data.audit.some((a) => a.action === "import" && /old tracker/.test(a.reason));
    add(out, 
      h(
        "div",
        { class: "card" },
        h("h3", null, "Found in ", source),
        h("p", null, `${legacy.entries.length} old daily entries → ${conv.sessions.length} summary sessions with ${visits} patient visits at ${conv.locations.length} locations (${conv.payers.length} hospitals).`),
        h("p", null, `${conv.settlements.length} monthly hospital payment records → finalised settlements (amount as entered in the old app).`),
        conv.skippedAdmissions ? h("p", { class: "small muted" }, `${conv.skippedAdmissions} admission records (patient names) are not imported. They stay in the old tracker.`) : null,
        conv.expensesPaise ? h("p", { class: "small muted" }, `Expenses of ${money(conv.expensesPaise)} are outside this app's scope and are not imported.`) : null,
        h("p", { class: "small muted" }, "Imported locations are set to 'hospital collects'. Review them in Locations & fees, and set each hospital's agreement."),
        already ? h("p", { class: "badc" }, "⚠ An import from the old tracker was already done. Importing again would duplicate those sessions.") : null,
        h("button", { class: "btn primary", onclick: async () => {
          if (already && !(await confirmDialog("Import again?", "This will add a second copy of the old entries.", { danger: true, ok: "Import again" }))) return;
          const { skippedAdmissions, expensesPaise, ...records } = conv;
          if (await attempt(() => store.importRecords(records, `Imported from old tracker (${source})`).then(() => true))) {
            toast("Imported ✓");
            app.go("home");
          }
        } }, "Import"),
      ),
    );
  };
  const local = app.mode === "real" ? readLegacyLocalStorage() : null;
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Import from old tracker"),
    h("p", { class: "small" }, "The earlier version of this app (", h("a", { href: "legacy.html" }, "legacy.html"), ") kept data in this browser's local storage. Importing copies it; the old data is left untouched."),
    local ? h("button", { class: "btn", onclick: () => preview(local, "this browser") }, `Use old data found on this device (${local.entries.length} entries)`) : h("p", { class: "muted small" }, "No old-tracker data found in this browser."),
    h("div", { class: "card" }, h("h3", null, "Or choose an old backup file"), h("input", { type: "file", accept: "application/json,.json", onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await readFileText(f));
        if (!data.entries) throw new Error("Not an old-tracker backup (no entries).");
        preview(data, f.name);
      } catch (err) {
        add(clear(out), h("p", { class: "err" }, err.message));
      }
    } })),
    out,
  );
}

// ------------------------------------------------------- clinical settings

const SECTION_LABELS = { complaints: "Chief complaints", history: "History", comorbidities: "Comorbidities", allergies: "Allergies", currentMeds: "Current medications (reported)", vitals: "Vitals", exam: "Examination", investigations: "Investigations", diagnoses: "Assessment & diagnosis", treatment: "Treatment / prescription", advice: "Advice", followUp: "Follow-up" };
const KIND_LABELS = { exam: "Examination templates", prescription: "Prescription templates", medicine: "Medicine favourites" };

export function renderClinicalSettings(app) {
  const store = app.store;
  const existing = store.data.templates.find((t) => t.kind === "note");
  const cur = store.noteTemplate;
  const st = { style: cur.style, sections: { ...cur.sections }, required: { ...DEFAULT_REQUIRED, ...(existing?.data.required || {}) } };
  const header = h("textarea", { rows: 3, value: cur.header || "", placeholder: "e.g. Dr. Name, MBBS, MD (Medicine) · Reg. No. … · Clinic address · Phone" });
  const save = () => attempt(() => store.saveTemplate({ id: existing?.id, kind: "note", name: "Note layout", data: { style: st.style, header: header.value, sections: st.sections, required: st.required } })).then((t) => t && toast("Saved ✓"));
  const lists = Object.entries(KIND_LABELS).map(([kind, label]) => {
    const ts = store.data.templates.filter((t) => t.kind === kind);
    return h("div", { class: "card" }, h("h3", null, label), ts.length ? ts.map((t) => h("div", { class: "row" }, h("span", { class: "grow" }, t.name), h("button", { class: "link small", onclick: async () => { if (await confirmDialog("Delete template", t.name, { danger: true, ok: "Delete" })) attempt(() => store.deleteTemplate(t.id)).then(() => app.render()); } }, "delete"))) : h("p", { class: "small muted" }, "None yet — save them from a consultation."));
  });
  return h(
    "div",
    { class: "screen" },
    h("h1", null, "Clinical note & templates"),
    h(
      "div",
      { class: "card" },
      h("h3", null, "Consultation note layout"),
      field("Style", segmented([{ value: "standard", label: "Standard sections" }, { value: "soap", label: "SOAP (S / O / A / P)" }], st.style, (v) => (st.style = v))),
      field("Letterhead (printed at the top)", header),
      h("div", { class: "grid2" }, Object.entries(SECTION_LABELS).map(([k, label]) => h("label", { class: "check small" }, h("input", { type: "checkbox", checked: st.sections[k] !== false, onchange: (e) => (st.sections[k] = e.target.checked) }), " ", label))),
      h("h3", null, "Required documentation"),
      h("p", { class: "small muted" }, "Consultations missing these are listed on the home screen. Nothing blocks you from saving."),
      h("div", { class: "grid2" }, [["complaint", "Chief complaint"], ["vitals", "Vitals"], ["exam", "Examination"], ["diagnosis", "Diagnosis"]].map(([k, label]) => h("label", { class: "check small" }, h("input", { type: "checkbox", checked: !!st.required[k], onchange: (e) => (st.required[k] = e.target.checked) }), " ", label))),
      h("button", { class: "btn primary", onclick: save }, "Save"),
    ),
    lists,
  );
}
