// Offline shell for the Captain's Log. The app's own files and its libraries are served
// from the cache and refreshed in the background; the index itself lives in IndexedDB and
// GitHub calls always go to the network. Bump VERSION when the shell changes shape.
const VERSION = "cl-shell-2";
const SHELL = [
  "./", "index.html", "app.css", "manifest.webmanifest",
  "js/app.js", "js/index.js", "js/brief.js", "js/store.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1-build1/sqlite-wasm/jswasm/sqlite3.mjs",
  "https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1-build1/sqlite-wasm/jswasm/sqlite3.wasm",
  "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js",
];
const CACHEABLE = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  if (own && url.pathname.includes("/data/")) return; // the index: always the network
  if (!own && !CACHEABLE.test(req.url)) return; // api.github.com and anything else
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { put(new Request("index.html"), r.clone()); return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const fresh = fetch(req).then((r) => { if (r.ok) put(req, r.clone()); return r; }).catch(() => hit);
    return hit || fresh;
  }));
});

function put(req, res) {
  caches.open(VERSION).then((c) => c.put(req, res)).catch(() => {});
}
