// Sovelluksen offline-välimuisti. Päivitä VERSIO, kun tiedostot muuttuvat.
const VERSIO = "treeni-0.1.0";
const TIEDOSTOT = ["./", "index.html", "style.css", "app.js", "firebase-bundle.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSIO).then(c => c.addAll(TIEDOSTOT))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSIO).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Firebase-liikenne suoraan verkkoon
  // verkko ensin (uusin versio), välimuisti varalla ilman yhteyttä
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSIO).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
