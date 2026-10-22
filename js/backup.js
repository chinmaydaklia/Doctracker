// Full-data export, verification and restore.
// A backup file holds every record of every store plus a SHA-256 checksum, so a
// damaged or edited file is detected before it can replace the data on this device.

import { DATA_STORES, DATA_FORMAT } from "./model.js";
import { newId } from "./ids.js";

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedStores(data) {
  const stores = {};
  for (const s of DATA_STORES) stores[s] = [...(data[s] || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return stores;
}

export async function buildBackup(data, { demo = false } = {}) {
  const stores = sortedStores(data);
  const counts = Object.fromEntries(DATA_STORES.map((s) => [s, stores[s].length]));
  return {
    app: "doctracker",
    format: DATA_FORMAT,
    demo,
    exportedAt: new Date().toISOString(),
    counts,
    checksum: await sha256(canonical(stores)),
    stores,
  };
}

// Referential integrity: every link points at an existing record.
export function checkRelationships(stores) {
  const errors = [];
  const ids = Object.fromEntries(DATA_STORES.map((s) => [s, new Set((stores[s] || []).map((r) => r.id))]));
  const need = (cond, msg) => {
    if (!cond && errors.length < 50) errors.push(msg);
  };
  for (const s of DATA_STORES) {
    const seen = new Set();
    for (const r of stores[s] || []) {
      need(r && r.id, `${s}: record without id`);
      need(!seen.has(r.id), `${s}: duplicate id ${r.id}`);
      seen.add(r.id);
    }
  }
  for (const l of stores.locations || []) need(!l.payerId || ids.payers.has(l.payerId), `Location ${l.name} → missing hospital`);
  for (const r of stores.rates || []) need(ids.locations.has(r.locationId), `Rate ${r.id} → missing location`);
  for (const a of stores.agreements || []) need(ids.payers.has(a.payerId), `Agreement ${a.id} → missing hospital`);
  for (const s of stores.sessions || []) need(ids.locations.has(s.locationId), `Session ${s.id} → missing location`);
  for (const v of stores.visits || []) need(ids.sessions.has(v.sessionId), `Visit ${v.id} → missing session`);
  for (const p of stores.payments || []) {
    need(!p.sessionId || ids.sessions.has(p.sessionId), `Payment ${p.id} → missing session`);
    need(!p.payerId || ids.payers.has(p.payerId), `Payment ${p.id} → missing hospital`);
    need(Number.isInteger(p.amountPaise), `Payment ${p.id} → amount is not whole paise`);
  }
  const targetStore = { visit: "visits", session: "sessions", settlement: "settlements" };
  for (const a of stores.allocations || []) {
    need(ids.payments.has(a.paymentId), `Allocation ${a.id} → missing payment`);
    need(targetStore[a.targetType] && ids[targetStore[a.targetType]].has(a.targetId), `Allocation ${a.id} → missing ${a.targetType}`);
  }
  for (const a of stores.adjustments || []) need(targetStore[a.targetType] && ids[targetStore[a.targetType]].has(a.targetId), `Adjustment ${a.id} → missing ${a.targetType}`);
  for (const s of stores.settlements || []) need(ids.payers.has(s.payerId), `Settlement ${s.id} → missing hospital`);
  return errors;
}

export async function verifyBackup(obj) {
  const errors = [];
  if (!obj || obj.app !== "doctracker" || !obj.stores) return { ok: false, errors: ["This is not a Doctracker backup file."] };
  if (obj.format > DATA_FORMAT) return { ok: false, errors: ["This backup was made by a newer version of the app. Update the app first."] };
  for (const s of DATA_STORES) if (!Array.isArray(obj.stores[s])) errors.push(`Missing section: ${s}`);
  if (errors.length) return { ok: false, errors };
  const stores = sortedStores(obj.stores);
  const checksum = await sha256(canonical(stores));
  if (checksum !== obj.checksum) errors.push("Checksum mismatch: the file is damaged or was edited.");
  for (const s of DATA_STORES) if (obj.counts && obj.counts[s] !== stores[s].length) errors.push(`Record count mismatch in ${s}.`);
  errors.push(...checkRelationships(stores));
  return { ok: errors.length === 0, errors, counts: Object.fromEntries(DATA_STORES.map((s) => [s, stores[s].length])), exportedAt: obj.exportedAt, demo: !!obj.demo };
}

// Record that a backup file was produced (and optionally verified).
export async function markBackedUp(store, { counts, checksum, fileName, verified }) {
  const now = store.clock();
  const entry = { id: newId("BK"), at: now, kind: "export", counts, checksum, fileName, verified: !!verified };
  const meta = { ...store.backupMeta, lastBackupAt: now, lastBackupChecksum: checksum };
  if (verified) meta.lastVerifiedAt = now;
  await store.commit([{ store: "backups", put: entry }, { store: "meta", put: meta }], [], { dataChange: false });
}

// Restore replaces everything. The current data is kept in the local "snapshots"
// store first (last 3 kept) so a wrong restore can be undone.
export async function restoreBackup(store, obj) {
  const v = await verifyBackup(obj);
  if (!v.ok) throw new Error("Backup failed verification:\n" + v.errors.join("\n"));
  const snap = await buildBackup(store.data);
  const now = store.clock();
  const old = [...store.data.snapshots].sort((a, b) => b.at - a.at).slice(2);
  await store.adapter.write([...old.map((s) => ({ store: "snapshots", del: s.id })), { store: "snapshots", put: { id: newId("SNAP"), at: now, reason: "Before restore", backup: snap } }]);
  const stores = structuredClone(obj.stores);
  // Keep this device's preferences, but mark the data as just restored.
  const meta = (stores.meta || []).filter((m) => m.id !== "backup" && m.id !== "settings");
  const settings = store.data.meta.find((m) => m.id === "settings");
  if (settings) meta.push(settings);
  meta.push({ id: "backup", lastBackupAt: now, lastChangeAt: now, lastVerifiedAt: now, restoredFrom: obj.exportedAt });
  stores.meta = meta;
  stores.backups = [...(stores.backups || []), { id: newId("BK"), at: now, kind: "restore", counts: v.counts, checksum: obj.checksum, fileName: "", verified: true }];
  await store.replaceAll(stores, { action: "restore", entity: "database", entityId: "all", reason: `Restored backup exported ${obj.exportedAt}` });
  await store.reload();
  return v;
}

export async function restoreSnapshot(store, snapId) {
  const snap = store.data.snapshots.find((s) => s.id === snapId);
  if (!snap) throw new Error("Snapshot not found.");
  return restoreBackup(store, snap.backup);
}
