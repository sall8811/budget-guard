const CACHE = "budget-lens-v12";
const VERSION = "20260929-6";
const ASSETS = [
  "./",
  "./index.html",
  `./css/tokens.css?v=${VERSION}`,
  `./css/app.css?v=${VERSION}`,
  `./js/db.js?v=${VERSION}`,
  `./js/model.js?v=${VERSION}`,
  `./js/app.js?v=${VERSION}`,
  `./manifest.webmanifest?v=${VERSION}`,
  "./icon.svg"
];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: "window" }))
    .then(clients => Promise.all(clients.map(client => client.navigate(client.url))))
));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then(response => {
      const clone = response.clone();
      caches.open(CACHE).then(cache => cache.put("./index.html", clone));
      return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const clone = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, clone));
    return response;
  })));
});
