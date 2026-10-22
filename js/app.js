// App bootstrap: storage, router, header status, service worker.
import { Store } from "./store.js";
import { openIndexedDB, memoryAdapter, REAL_DB, DEMO_DB } from "./db.js";
import { h, add, clear, toast } from "./ui/dom.js";
import { L, setHindi } from "./i18n.js";
import { fmtDateTime } from "./dates.js";
import { screens } from "./ui/screens.js";

const MODE_KEY = "dt_mode";
const TABS = [
  ["home", "home", "⌂"],
  ["add", "add", "+"],
  ["sessions", "sessions", "☰"],
  ["money", "money", "₹"],
  ["reports", "reports", "▤"],
  ["more", "more", "⋯"],
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

  go(name, params = {}, { replace = false } = {}) {
    if (!screens[name]) name = "home";
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
    const scr = screens[this.current.name];
    clear(main);
    try {
      add(main, scr.render(this, this.current.params || {}));
    } catch (e) {
      console.error(e);
      add(main, h("div", { class: "card err" }, "Something went wrong showing this screen: " + e.message));
    }
    const tab = scr.tab || scr.parent || "home";
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    this.renderStatus();
  },

  async switchMode(mode) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    location.hash = "#home";
    location.reload();
  },

  renderStatus() {
    const el = document.getElementById("status");
    if (!el || !this.store) return;
    clear(el);
    const bm = this.store.backupMeta;
    const saved = this.store.adapter.kind === "indexeddb";
    add(el, 
      h("span", { class: "chip " + (saved ? "ok" : "bad"), title: saved ? "Every entry is written to this device's database before 'Saved' is shown" : "Storage unavailable: data will be lost when this tab closes" }, saved ? "● Saved on this device" : "⚠ NOT SAVED (no storage)"),
    );
    let bk;
    if (!bm.lastBackupAt) bk = h("span", { class: "chip warn", onclick: () => this.go("backup") }, "⚠ Never backed up");
    else if (bm.lastChangeAt && bm.lastChangeAt > bm.lastBackupAt) {
      const days = Math.floor((Date.now() - bm.lastBackupAt) / 864e5);
      bk = h("span", { class: "chip " + (days >= 3 ? "warn" : "mid"), onclick: () => this.go("backup"), title: "Last backup " + fmtDateTime(bm.lastBackupAt) }, days >= 1 ? `Backup ${days}d old` : "Changes since backup");
    } else bk = h("span", { class: "chip ok", onclick: () => this.go("backup") }, "✓ Backed up");
    add(el, bk, h("span", { class: "chip mid", title: "Data lives only on this device. It is not synchronised between devices." }, "Local only"));
  },
};

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
  setHindi(app.store.settings.showHindi);
  app.store.onChange(() => app.renderStatus());

  if (navigator.storage && navigator.storage.persist) {
    try {
      app.persistent = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch {}
  }

  const nav = document.getElementById("nav");
  for (const [name, key, icon] of TABS) {
    add(nav, h("button", { type: "button", dataset: { tab: name }, onclick: () => app.go(name) }, h("span", { class: "ic", "aria-hidden": "true" }, icon), L(key)));
  }
  if (app.mode === "demo") {
    add(document.getElementById("banner"), 
      h("div", { class: "demo-banner" }, "DEMO DATA — not your real records. ", h("button", { class: "link", onclick: () => app.switchMode("real") }, "Switch to my records")),
    );
  }
  window.addEventListener("popstate", () => {
    const name = location.hash.slice(1) || "home";
    if (app.stack.length && app.stack[app.stack.length - 1].name === name) app.back();
    else {
      app.current = { name: screens[name] ? name : "home", params: {} };
      app.render();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (document.querySelector("[data-dirty='1']")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  const first = !app.store.data.locations.length;
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
