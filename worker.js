// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = new URL(env.ORIGIN);

    // Rebuild the URL towards the origin server
    const target = new URL(url.pathname + url.search, origin);

    // For POST/PUT to /api, don't cache; otherwise allow default edge caching
    const isApi = url.pathname.startsWith("/api/");
    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      cf: isApi ? { cacheTtl: 0, cacheEverything: false } : undefined
    };

    // Ensure Host header matches the origin
    init.headers.set("Host", origin.host);

    const resp = await fetch(target, init);

    // Optionally strip hop-by-hop headers
    const headers = new Headers(resp.headers);
    headers.delete("transfer-encoding");
    headers.delete("connection");

    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }
};
