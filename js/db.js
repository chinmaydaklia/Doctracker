// Storage adapters. The app keeps every record in memory for fast calculation and
// writes each change to IndexedDB in a single transaction before reporting "Saved".
//
// Adapter interface:
//   loadAll()            -> { storeName: [records] }
//   write(ops)           -> ops: [{ store, put: record } | { store, del: id } | { store, clear: true }]
//                           applied atomically (all or nothing)
//   close()

import { STORES, DB_SCHEMA_VERSION } from "./model.js";

export const REAL_DB = "doctracker";
export const DEMO_DB = "doctracker-demo";

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openIndexedDB(name, idb = globalThis.indexedDB) {
  if (!idb) throw new Error("IndexedDB is not available in this browser.");
  const req = idb.open(name, DB_SCHEMA_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const s of STORES) {
      if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
    }
  };
  const db = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Database upgrade blocked: close other tabs of this app."));
  });

  return {
    kind: "indexeddb",
    name,
    async loadAll() {
      const tx = db.transaction(STORES, "readonly");
      const out = {};
      await Promise.all(STORES.map(async (s) => (out[s] = await promisify(tx.objectStore(s).getAll()))));
      return out;
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
    async loadAll() {
      const out = {};
      for (const s of STORES) out[s] = [...data[s].values()].map((r) => structuredClone(r));
      return out;
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
