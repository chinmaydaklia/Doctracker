/* Doctracker service worker: the app shell is cached so the installed app opens and
   works with no network. Same-origin requests are served from cache first and
   refreshed in the background; bump VERSION on every release. No data is cached
   here — records live in IndexedDB. */
const VERSION = "doctracker-v2.0.1";
const SHELL = [
  "./",
  "./index.html",
  "./legacy.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./js/app.js",
  "./js/backup.js",
  "./js/calc.js",
  "./js/csv.js",
  "./js/dates.js",
  "./js/db.js",
  "./js/demo.js",
  "./js/i18n.js",
  "./js/ids.js",
  "./js/insights.js",
  "./js/legacy.js",
  "./js/model.js",
  "./js/money.js",
  "./js/reports.js",
  "./js/store.js",
  "./js/ui/dom.js",
  "./js/ui/entry.js",
  "./js/ui/home.js",
  "./js/ui/money.js",
  "./js/ui/reportsui.js",
  "./js/ui/screens.js",
  "./js/ui/sessions.js",
  "./js/ui/settings.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        e.waitUntil(refresh);
        return hit;
      }
      const res = await refresh;
      if (res) return res;
      if (req.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
      return Response.error();
    }),
  );
});
