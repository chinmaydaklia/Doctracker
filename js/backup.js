// Full-data export, verification and restore.
// A backup file holds every record of every store plus a SHA-256 checksum, so a
// damaged or edited file is detected before it can replace the data on this device.
// Clinical records and attachments are exported exactly as stored: encrypted. A
// backup can only be read clinically with a doctor's password or the recovery code.

import { DATA_STORES, DATA_FORMAT, storesForFormat } from "./model.js";
import { newId } from "./ids.js";
import { toB64, fromB64 } from "./crypto.js";

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    // Keys with undefined values are skipped, exactly as JSON.stringify drops them.
    return "{" + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedStores(data, names = DATA_STORES) {
  const stores = {};
  for (const s of names) stores[s] = [...(data[s] || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return stores;
}

// Collect what is on disk (clinical encrypted) plus attachment bytes as base64.
export async function exportStores(store) {
  const data = store.diskData();
  const blobs = await store.adapter.getAll("blobs");
  data.blobs = blobs.map((b) => ({ id: b.id, iv: b.iv, data: toB64(b.data) }));
  return data;
}

export async function buildBackup(store, { demo = false } = {}) {
  if (typeof store.diskData !== "function") throw new Error("buildBackup needs the store (never plain decrypted data).");
  const stores = sortedStores(await exportStores(store));
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
  for (const v of stores.visits || []) {
    need(ids.sessions.has(v.sessionId), `Visit ${v.id} → missing session`);
    need(!v.patientRecordId || ids.patients.has(v.patientRecordId), `Visit ${v.id} → missing patient record`);
  }
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
  // Clinical links (stored in clear even though the content is encrypted).
  for (const e of stores.encounters || []) {
    need(ids.patients.has(e.patientId), `Encounter ${e.id} → missing patient`);
    need(!e.visitId || ids.visits.has(e.visitId), `Encounter ${e.id} → missing visit`);
    need(!e.sessionId || ids.sessions.has(e.sessionId), `Encounter ${e.id} → missing session`);
  }
  for (const s of ["profiles", "conditions", "allergies", "medications", "vitals", "diagnoses", "investigations", "prescriptions", "noteVersions", "files"]) {
    for (const r of stores[s] || []) {
      need(ids.patients.has(r.patientId), `${s} ${r.id} → missing patient`);
      need(!r.encounterId || ids.encounters.has(r.encounterId), `${s} ${r.id} → missing encounter`);
    }
  }
  for (const f of stores.files || []) {
    need(!f.investigationId || ids.investigations.has(f.investigationId), `File ${f.id} → missing investigation`);
    need(ids.blobs.has(f.id), `File ${f.id} → missing attachment data`);
  }
  return errors;
}

export async function verifyBackup(obj) {
  const errors = [];
  if (!obj || obj.app !== "doctracker" || !obj.stores) return { ok: false, errors: ["This is not a Doctracker backup file."] };
  if (obj.format > DATA_FORMAT) return { ok: false, errors: ["This backup was made by a newer version of the app. Update the app first."] };
  // Older formats lack the stores added later (1: financial only; 2: no scans).
  const names = storesForFormat(obj.format || 1);
  for (const s of names) if (!Array.isArray(obj.stores[s])) errors.push(`Missing section: ${s}`);
  if (errors.length) return { ok: false, errors };
  const stores = sortedStores(obj.stores, names);
  const checksum = await sha256(canonical(stores));
  if (checksum !== obj.checksum) errors.push("Checksum mismatch: the file is damaged or was edited.");
  for (const s of names) if (obj.counts && obj.counts[s] !== stores[s].length) errors.push(`Record count mismatch in ${s}.`);
  errors.push(...checkRelationships(sortedStores(obj.stores)));
  return { ok: errors.length === 0, errors, format: obj.format, counts: Object.fromEntries(names.map((s) => [s, stores[s].length])), exportedAt: obj.exportedAt, demo: !!obj.demo };
}

// Record that a backup file was produced (and optionally verified).
export async function markBackedUp(store, { counts, checksum, fileName, verified }) {
  const now = store.clock();
  const entry = { id: newId("BK"), at: now, kind: "export", counts, checksum, fileName, verified: !!verified };
  const meta = { ...store.backupMeta, lastBackupAt: now, lastBackupChecksum: checksum };
  if (verified) meta.lastVerifiedAt = now;
  await store.commit([{ store: "backups", put: entry }, { store: "meta", put: meta }], [], { dataChange: false });
}

async function keepSafetyCopy(store, reason) {
  const snap = await buildBackup(store);
  const now = store.clock();
  const existing = await store.adapter.getAll("snapshots");
  const old = existing.filter((s) => !String(s.id).startsWith("SNAP-UPGRADE")).sort((a, b) => b.at - a.at).slice(2);
  await store.adapter.write([...old.map((s) => ({ store: "snapshots", del: s.id })), { store: "snapshots", put: { id: newId("SNAP"), at: now, reason, backup: snap } }]);
}

// Restore replaces everything. The current data is kept in the local "snapshots"
// store first (last 3 kept) so a wrong restore can be undone.
export async function restoreBackup(store, obj, { safetyCopy = true } = {}) {
  const v = await verifyBackup(obj);
  if (!v.ok) throw new Error("Backup failed verification:\n" + v.errors.join("\n"));
  if (safetyCopy) await keepSafetyCopy(store, "Before restore");
  const now = store.clock();
  const stores = structuredClone(obj.stores);
  stores.blobs = (stores.blobs || []).map((b) => ({ id: b.id, iv: b.iv, data: fromB64(b.data) }));
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

export async function listSnapshots(store) {
  return (await store.adapter.getAll("snapshots")).map((s) => ({ id: s.id, at: s.at, reason: s.reason })).sort((a, b) => b.at - a.at);
}

export async function restoreSnapshot(store, snapId) {
  const snap = await store.adapter.get("snapshots", snapId);
  if (!snap) throw new Error("Snapshot not found.");
  if (snap.backup) return restoreBackup(store, snap.backup);
  // Pre-upgrade copy: raw financial stores of the older schema.
  await keepSafetyCopy(store, "Before restoring pre-upgrade copy");
  const stores = Object.fromEntries(DATA_STORES.map((s) => [s, snap.stores[s] || []]));
  await store.replaceAll(stores, { action: "restore", entity: "database", entityId: "all", reason: snap.reason });
  await store.reload();
  return { ok: true };
}
