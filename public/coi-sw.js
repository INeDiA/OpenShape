// Cross-origin isolation for static hosts that can't send custom headers
// (GitHub Pages). The kernel's multi-threaded OCCT build needs
// SharedArrayBuffer, which browsers only allow on cross-origin isolated pages:
// this worker adds the COOP/COEP headers to every response it serves.
// index.html registers it only when the page isn't isolated already (the dev
// server and `vite preview` send the headers themselves).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Chrome throws on this combination (devtools requests); let the browser handle it.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(
    fetch(request).then((response) => {
      // Opaque responses (cross-origin, no-cors) can't be changed.
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
