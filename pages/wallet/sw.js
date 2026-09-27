/* Pearl Wallet service worker — offline app shell for the installed PWA.
   Strategy: cache-first for same-origin app assets; network-only for
   everything else (Blockbook / indexer / CoinGecko must never be cached —
   balances and prices go stale fast, and cached API data would lie).
*/
var CACHE = "pearl-wallet-v1";
var SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./pearl-wallet.bundle.js",
  "./qrcode.min.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  // API traffic: never cache, never serve stale.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: false }).then(function (hit) {
      if (hit) return hit;
      return fetch(event.request).then(function (res) {
        // opportunistic: cache same-origin GETs we didn't pre-cache
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        return res;
      });
    }).catch(function () {
      // offline + not cached: serve the shell for navigations
      if (event.request.mode === "navigate") return caches.match("./index.html");
      throw new Error("offline");
    })
  );
});
