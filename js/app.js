// App bootstrap: storage, sign-in gate, router, header status, auto-lock, service worker.
import { Store } from "./store.js";
import "./clinical-store.js";
import { openIndexedDB, memoryAdapter, REAL_DB, DEMO_DB } from "./db.js";
import { signOut } from "./auth.js";
import { h, add, clear, toast } from "./ui/dom.js";
import { L, setHindi } from "./i18n.js";
import { fmtDateTime } from "./dates.js";
import { screens } from "./ui/screens.js";

const MODE_KEY = "dt_mode";
const TABS = [
  ["home", "home", "⌂", null],
  ["patients", "patients", "♥", "patients"],
  ["add", "add", "+", "finance"],
  ["sessions", "sessions", "☰", "finance"],
  ["money", "money", "₹", "finance"],
  ["reports", "reports", "▤", "reports"],
  ["more", "more", "⋯", null],
];

function getMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "demo" ? "demo" : "real";
  } catch {
    return "real";
  }
}

export const app = {
  store: null,
  mode: "real",
  persistent: false,
  current: { name: "home", params: {} },
  stack: [],
  lastActivity: Date.now(),

  allowed(name) {
    const scr = screens[name];
    return scr && (!scr.perm || this.store.perms.includes(scr.perm));
  },

  go(name, params = {}, { replace = false } = {}) {
    if (!screens[name]) name = "home";
    if (!this.allowed(name)) {
      toast("Your account cannot open that screen.", "err");
      name = "home";
    }
    if (!replace && this.current.name !== name) this.stack.push(this.current);
    if (screens[name].tab) this.stack = [];
    this.current = { name, params };
    const hash = "#" + name;
    if (location.hash !== hash) history.pushState(null, "", hash);
    this.render();
  },

  back() {
    const prev = this.stack.pop();
    if (prev) {
      this.current = prev;
      history.replaceState(null, "", "#" + prev.name);
      this.render();
    } else this.go("home");
  },

  render() {
    const main = document.getElementById("main");
    clear(main);
    const gated = this.store.authEnabled && !this.store.session;
    document.body.classList.toggle("locked", gated);
    this.renderNav();
    if (gated) {
      add(main, screens.login.render(this, {}));
      this.renderStatus();
      return;
    }
    if (!this.allowed(this.current.name)) this.current = { name: "home", params: {} };
    const scr = screens[this.current.name];
    try {
      add(main, scr.render(this, this.current.params || {}));
    } catch (e) {
      console.error(e);
      add(main, h("div", { class: "card err" }, "Something went wrong showing this screen: " + e.message));
    }
    const tab = scr.tab ? this.current.name : scr.parent || "home";
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    window.scrollTo(0, 0);
    this.renderStatus();
  },

  renderNav() {
    const nav = document.getElementById("nav");
    clear(nav);
    if (this.store.authEnabled && !this.store.session) return;
    for (const [name, key, icon, perm] of TABS) {
      if (perm && !this.store.perms.includes(perm)) continue;
      add(nav, h("button", { type: "button", dataset: { tab: name }, onclick: () => app.go(name) }, h("span", { class: "ic", "aria-hidden": "true" }, icon), L(key)));
    }
  },

  async switchMode(mode) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    location.hash = "#home";
    location.reload();
  },

  // Lock: forget the signed-in user and the decrypted clinical data.
  async lock(reason) {
    if (!this.store.session) return;
    await signOut(this.store);
    this.stack = [];
    this.current = { name: "home", params: {} };
    this.render();
    if (reason) toast(reason);
  },

  renderStatus() {
    const el = document.getElementById("status");
    if (!el || !this.store) return;
    clear(el);
    const st = this.store;
    const bm = st.backupMeta;
    const saved = st.adapter.kind === "indexeddb";
    add(el, h("span", { class: "chip " + (saved ? "ok" : "bad"), title: saved ? "Every entry is written to this device's database before 'Saved' is shown" : "Storage unavailable: data will be lost when this tab closes" }, saved ? "● Saved on this device" : "⚠ NOT SAVED (no storage)"));
    if (!st.authEnabled || st.perms.includes("backup")) {
      let bk;
      if (!bm.lastBackupAt) bk = h("span", { class: "chip warn", onclick: () => this.go("backup") }, "⚠ Never backed up");
      else if (bm.lastChangeAt && bm.lastChangeAt > bm.lastBackupAt) {
        const days = Math.floor((Date.now() - bm.lastBackupAt) / 864e5);
        bk = h("span", { class: "chip " + (days >= 3 ? "warn" : "mid"), onclick: () => this.go("backup"), title: "Last backup " + fmtDateTime(bm.lastBackupAt) }, days >= 1 ? `Backup ${days}d old` : "Changes since backup");
      } else bk = h("span", { class: "chip ok", onclick: () => this.go("backup") }, "✓ Backed up");
      add(el, bk);
    }
    add(el, h("span", { class: "chip mid", title: "Data lives only on this device. It is not synchronised between devices." }, "Local only"));
    if (st.session) {
      add(el, h("span", { class: "chip mid", title: st.dek ? "Clinical records unlocked (encrypted on disk)" : "No access to clinical records" }, (st.dek ? "🔓 " : "") + st.session.name), h("button", { class: "chip lockbtn", onclick: () => this.lock("Locked.") }, "Lock"));
    }
  },
};

const IDLE_CHECK_MS = 20000;
function lockMinutes() {
  return Number(app.store.settings.lockMinutes) || 10;
}

async function boot() {
  app.mode = getMode();
  document.body.classList.toggle("demo", app.mode === "demo");
  let adapter;
  try {
    adapter = await openIndexedDB(app.mode === "demo" ? DEMO_DB : REAL_DB);
  } catch (e) {
    console.error(e);
    adapter = memoryAdapter();
    setTimeout(() => toast("This browser blocked local storage (private mode?). Entries will NOT be kept.", "err"), 500);
  }
  app.store = await Store.open(adapter);
  if (adapter.migration) app.migration = adapter.migration;
  setHindi(app.store.settings.showHindi);
  app.store.onChange(() => app.renderStatus());

  if (navigator.storage && navigator.storage.persist) {
    try {
      app.persistent = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch {}
  }

  if (app.mode === "demo") {
    add(document.getElementById("banner"), h("div", { class: "demo-banner" }, "DEMO DATA — not your real records. ", h("button", { class: "link", onclick: () => app.switchMode("real") }, "Switch to my records")));
  }
  window.addEventListener("popstate", () => {
    const name = location.hash.slice(1) || "home";
    if (app.stack.length && app.stack[app.stack.length - 1].name === name) app.back();
    else {
      app.current = { name: screens[name] && !screens[name].needsParams ? name : "home", params: {} };
      app.render();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (document.querySelector("[data-dirty='1']")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Auto-lock after inactivity, and when the app has been in the background too long.
  for (const ev of ["pointerdown", "keydown", "touchstart", "scroll"]) window.addEventListener(ev, () => (app.lastActivity = Date.now()), { passive: true });
  let hiddenAt = null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > lockMinutes() * 60000) app.lock("Locked after inactivity.");
  });
  setInterval(() => {
    if (app.store.session && Date.now() - app.lastActivity > lockMinutes() * 60000) app.lock("Locked after inactivity.");
  }, IDLE_CHECK_MS);

  const first = !app.store.data.locations.length && !app.store.authEnabled;
  const start = location.hash.slice(1);
  app.current = { name: first ? "welcome" : screens[start] && !screens[start].needsParams ? start : "home", params: {} };
  history.replaceState(null, "", "#" + app.current.name);
  app.render();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker not registered", e));
  }
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("main").textContent = "Could not start: " + e.message;
});
