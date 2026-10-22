// Storage adapters. The app keeps every record in memory for fast calculation and
// writes each change to IndexedDB in a single transaction before reporting "Saved".
//
// Adapter interface:
//   loadAll()            -> { storeName: [records] }   (lazy stores are not loaded)
//   get(store, id)       -> record | null              (for lazy stores: blobs, snapshots)
//   write(ops)           -> ops: [{ store, put: record } | { store, del: id } | { store, clear: true }]
//                           applied atomically (all or nothing)
//   close()
//   migration            -> { from, to, snapshotId } when this open upgraded the schema

import { STORES, LAZY_STORES, DB_SCHEMA_VERSION } from "./model.js";

export const REAL_DB = "doctracker";
export const DEMO_DB = "doctracker-demo";

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openRaw(idb, name, version, onupgrade) {
  const req = version ? idb.open(name, version) : idb.open(name);
  if (onupgrade) req.onupgradeneeded = (e) => onupgrade(req.result, e.oldVersion);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Database upgrade blocked: close other tabs of this app and reopen."));
  });
}

// Before an older database is upgraded, copy all of its records into the snapshots
// store (which already exists in schema 1), so the pre-upgrade state can be restored.
async function snapshotBeforeUpgrade(idb, name) {
  const db = await openRaw(idb, name);
  const from = db.version;
  // A brand-new device: opening without a version just created an empty database.
  const existing = db.objectStoreNames.length > 0;
  if (from >= DB_SCHEMA_VERSION || !db.objectStoreNames.contains("snapshots")) {
    db.close();
    return { from, existing, snapshotId: null };
  }
  // Every existing store except earlier safety copies and attachment bytes (which the
  // upgrade never touches).
  const names = [...db.objectStoreNames].filter((s) => s !== "snapshots" && s !== "blobs");
  const tx = db.transaction([...names, "snapshots"], "readwrite");
  const stores = {};
  await Promise.all(names.map(async (s) => (stores[s] = await promisify(tx.objectStore(s).getAll()))));
  const hasData = names.some((s) => s !== "meta" && stores[s].length);
  let snapshotId = null;
  if (hasData) {
    snapshotId = "SNAP-UPGRADE-" + from + "-" + Date.now();
    tx.objectStore("snapshots").put({ id: snapshotId, at: Date.now(), reason: `Before upgrade (schema ${from} → ${DB_SCHEMA_VERSION})`, raw: true, stores });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return { from, existing, snapshotId };
}

export async function openIndexedDB(name, idb = globalThis.indexedDB) {
  if (!idb) throw new Error("IndexedDB is not available in this browser.");
  let migration = null;
  const pre = await snapshotBeforeUpgrade(idb, name);
  const db = await openRaw(idb, name, DB_SCHEMA_VERSION, (db, oldVersion) => {
    // Additive only: existing stores and their records are never modified here.
    for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
    if (oldVersion > 0 && pre.existing) migration = { from: oldVersion, to: DB_SCHEMA_VERSION, snapshotId: pre.snapshotId };
  });
  const memStores = STORES.filter((s) => !LAZY_STORES.includes(s));

  return {
    kind: "indexeddb",
    name,
    migration,
    async loadAll() {
      const tx = db.transaction(memStores, "readonly");
      const out = {};
      await Promise.all(memStores.map(async (s) => (out[s] = await promisify(tx.objectStore(s).getAll()))));
      return out;
    },
    async get(store, id) {
      const tx = db.transaction([store], "readonly");
      return (await promisify(tx.objectStore(store).get(id))) || null;
    },
    async getAll(store) {
      const tx = db.transaction([store], "readonly");
      return promisify(tx.objectStore(store).getAll());
    },
    write(ops) {
      if (!ops.length) return Promise.resolve();
      const names = [...new Set(ops.map((o) => o.store))];
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
        for (const o of ops) {
          const st = tx.objectStore(o.store);
          if (o.clear) st.clear();
          else if (o.del !== undefined) st.delete(o.del);
          else st.put(o.put);
        }
      });
    },
    close() {
      db.close();
    },
  };
}

// In-memory adapter (unit tests, and fallback when IndexedDB is unavailable).
export function memoryAdapter(initial = {}) {
  const data = {};
  for (const s of STORES) data[s] = new Map((initial[s] || []).map((r) => [r.id, structuredClone(r)]));
  return {
    kind: "memory",
    name: "memory",
    migration: null,
    async loadAll() {
      const out = {};
      for (const s of STORES) if (!LAZY_STORES.includes(s)) out[s] = [...data[s].values()].map((r) => structuredClone(r));
      return out;
    },
    async get(store, id) {
      const r = data[store].get(id);
      return r ? structuredClone(r) : null;
    },
    async getAll(store) {
      return [...data[store].values()].map((r) => structuredClone(r));
    },
    async write(ops) {
      for (const o of ops) {
        if (o.clear) data[o.store].clear();
        else if (o.del !== undefined) data[o.store].delete(o.del);
        else data[o.store].set(o.put.id, structuredClone(o.put));
      }
    },
    close() {},
  };
}
