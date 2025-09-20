// api/[...all].js
// Vercel catch-all API — tiny router, no Express
// Endpoints:
//   GET  /api/health
//   GET  /api/articles
//   GET  /api/articles/:id
//   POST /api/articles          <-- replaces entire cache with payload
//
// Behavior:
// - Read-only FS safe (in-memory cache per instance).
// - If N8N_FEED_URL is set, background refresh seeds/replaces the cache.
// - If N8N_WEBHOOK_URL is set, POST payload is forwarded (fire-and-forget).
// - All outbound fetches have short timeouts to avoid hangs.

const N8N_FEED_URL   = process.env.N8N_FEED_URL   || "";
const N8N_WEBHOOK_URL= process.env.N8N_WEBHOOK_URL|| "";
const REFRESH_MS     = Number(process.env.REFRESH_MS || 60_000);

// ---- state (ephemeral per function instance) ----
let cache = { articles: [] };
let lastRefresh = 0;
let seeded = false;
let initDone = false;

// ---- utils ----
function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function normalizeArray(input) {
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((a, i) => ({
    id: a.id ?? a.index ?? a._id ?? `${Date.now()}-${i}`,
    headline: a.headline ?? a.title ?? "Untitled",
    content: a.content ?? "",
    createdAt: a.createdAt ?? new Date().toISOString()
  }));
}

// Fast fetch with timeout
function fetchJSON(url, { timeoutMs = 2000, ...opts } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

// Seed from env (replace cache)
function seedFromEnvJSON() {
  try {
    const raw = process.env.ARTICLES_JSON;
    if (!raw) return;
    const json = JSON.parse(raw);
    const list = Array.isArray(json) ? json : (json.articles || []);
    cache.articles = normalizeArray(list).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  } catch { /* ignore malformed */ }
}

// Refresh from external feed (replace cache)
async function refreshFromFeed() {
  if (!N8N_FEED_URL) { lastRefresh = Date.now(); return; }
  try {
    const res = await fetchJSON(N8N_FEED_URL, { timeoutMs: 2000 });
    if (!res.ok) { lastRefresh = Date.now(); return; }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.articles || []);
    const normalized = normalizeArray(list);
    cache.articles = normalized.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    ); // <-- REPLACE, don't merge
  } catch { /* keep existing cache on failure */ }
  finally { lastRefresh = Date.now(); }
}

// Non-blocking, one-time init
function ensureInit() {
  if (initDone) return;
  if (!seeded) { seedFromEnvJSON(); seeded = true; }
  refreshFromFeed().catch(() => {}); // fire-and-forget
  initDone = true;
}

// Refresh if stale (safe to call without await)
async function refreshIfStale() {
  const now = Date.now();
  if (!lastRefresh || (REFRESH_MS > 0 && (now - lastRefresh) > REFRESH_MS)) {
    await refreshFromFeed();
  }
}

// Read JSON body (1MB cap)
async function readJSON(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let buf = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      buf += chunk;
    });
    req.on("end", () => {
      if (!buf) return resolve(null);
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

// ---- router ----
module.exports = async (req, res) => {
  // CORS + preflight
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.statusCode = 204; return res.end();
  }
  res.setHeader("access-control-allow-origin", "*");

  ensureInit();                 // non-blocking
  refreshIfStale().catch(() => {}); // background refresh if stale

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname; // e.g. /api/articles or /api/articles/123

  // GET /api/health
  if (req.method === "GET" && path === "/api/health") {
    return json(res, 200, {
      ok: true,
      articles: cache.articles.length,
      source: N8N_FEED_URL ? "feed" : (process.env.ARTICLES_JSON ? "env" : "memory"),
      lastRefresh
    });
  }

  // GET /api/articles
  if (req.method === "GET" && path === "/api/articles") {
    return json(res, 200, { articles: cache.articles });
  }

  // GET /api/articles/:id
  if (req.method === "GET" && path.startsWith("/api/articles/")) {
    const id = path.slice("/api/articles/".length);
    const item = cache.articles.find(a => String(a.id) === String(id));
    if (!item) return json(res, 404, { error: "Not found" });
    return json(res, 200, item);
  }

  // POST /api/articles  (REPLACE entire list)
  if (req.method === "POST" && path === "/api/articles") {
    let body;
    try { body = await readJSON(req); }
    catch (e) {
      if (e.message === "payload_too_large") return json(res, 413, { error: "Payload too large" });
      if (e.message === "invalid_json") return json(res, 400, { error: "Invalid JSON" });
      return json(res, 400, { error: "Bad Request" });
    }
    if (!body) return json(res, 400, { error: "Missing body" });

    const normalized = normalizeArray(body);
    cache.articles = normalized.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    ); // <-- REPLACE everything

    // Fire-and-forget forward (optional)
    if (N8N_WEBHOOK_URL) {
      fetchJSON(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Array.isArray(body) ? body : [body]),
        timeoutMs: 1500
      }).catch(() => {});
    }

    return json(res, 201, {
      replaced: normalized.length,
      items: normalized,
      forward: { forwarded: !!N8N_WEBHOOK_URL }
    });
  }

  // Fallback
  return json(res, 404, { error: "Not found" });
};

// Ensure Node runtime with a short max duration
module.exports.config = { runtime: "nodejs18.x", maxDuration: 10 };
