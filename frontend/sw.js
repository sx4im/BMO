// Media-only service worker: precaches the hero video so it plays instantly,
// and leaves every other request (HTML, JS, CSS, API) to the network untouched.
// Bump CACHE whenever the cached hero asset changes.
const CACHE = "bmo-media-v3";
const MEDIA = ["/assets/hero.mp4"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(MEDIA)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !MEDIA.includes(url.pathname)) return;
  event.respondWith(serveMedia(request, url.pathname));
});

async function serveMedia(request, path) {
  const cached = await caches.match(path, { cacheName: CACHE });
  if (!cached) return fetch(request);
  const range = request.headers.get("range");
  if (!range) return cached;
  // <video> asks for byte ranges; a cached full body has to be sliced into a 206.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return cached;
  const body = await cached.arrayBuffer();
  const size = body.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}
