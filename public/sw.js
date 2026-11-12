const CACHE_NAME = "livetranscribe-pwa-v16";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./lib/instructions.js",
  "./lib/live-session.js",
  "./lib/session-loop.js",
  "./lib/srt.js",
  "./lib/usage.js",
  "./audio/capture.worklet.js",
  "./audio/playback.worklet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept API endpoints or WebSocket upgrades
  if (url.pathname.includes("/api/") || url.pathname.includes("/ws-relay")) {
    return;
  }

  // Network-first with cache fallback so updates deploy immediately while offline startup works
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === "navigate") {
          return caches.match("./index.html", { ignoreSearch: true });
        }
        throw new Error("Offline and not in cache");
      })
  );
});
