/* Pearl Wallet service worker — offline app shell for the installed PWA.
   Strategy: network-first for navigations / the HTML shell (the shell is
   the version manifest — it carries the ?v= pins for every asset, so a
   cache-first shell froze installed PWAs at whatever build was current
   when the cache name last changed, security fixes included); cache-first
   for the ?v=-pinned assets themselves (immutable under the fleet's
   cache-key discipline); network-only for everything cross-origin
   (Blockbook / indexer / CoinGecko must never be cached — balances and
   prices go stale fast, and cached API data would lie). Offline
   navigations fall back to the cached shell.
*/
var CACHE = "pearl-wallet-v3";
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
  // Navigations and the shell document: network-first, cache as fallback.
  var isShell = event.request.mode === "navigate" ||
    url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");
  if (isShell) {
    event.respondWith(
      fetch(event.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(event.request, { ignoreSearch: false })
          .then(function (hit) { return hit || caches.match("./index.html"); });
      })
    );
    return;
  }
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
