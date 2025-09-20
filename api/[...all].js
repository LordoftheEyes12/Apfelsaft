// Vercel catch-all API — tiny router (no Express), read-only safe, non-blocking
// Handles:
//   GET  /api/health
//   GET  /api/articles
//   GET  /api/articles/:id
//   POST /api/articles
//
// Notes:
// - In-memory cache only (per cold start).
// - Optional N8N_FEED_URL (GET) to seed/refresh cache (short timeout).
// - Optional N8N_WEBHOOK_URL (POST) to forward new articles (fire-and-forget).

const N8N_FEED_URL = process.env.N8N_FEED_URL || "";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const REFRESH_MS = Number(process.env.REFRESH_MS || 60_000);

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

function fetchJSON(url, { timeoutMs = 2000, ...opts } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

function seedFromEnvJSON() {
  try {
    const raw = process.env.ARTICLES_JSON;
    if (!raw) return;
    const json = JSON.parse(raw);
    const list = Array.isArray(json) ? json : (json.articles || []);
    cache.articles = normalizeArray(list);
  } catch { /* ignore malformed */ }
}

async function refreshFromFeed() {
  if (!N8N_FEED_URL) { lastRefresh = Date.now(); return; }
  try {
    const res = await fetchJSON(N8N_FEED_URL, { timeoutMs: 2000 });
    if (!res.ok) { lastRefresh = Date.now(); return; }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.articles || []);
    const normalized = normalizeArray(list);

    const byId = new Map(normalized.map(a => [String(a.id), a]));
    cache.articles.forEach(a => { if (!byId.has(String(a.id))) byId.set(String(a.id), a); });
    cache.articles = Array.from(byId.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { /* keep existing cache */ }
  finally { lastRefresh = Date.now(); }
}

function ensureInit() {
  if (initDone) return;
  if (!seeded) { seedFromEnvJSON(); seeded = true; }
  // Kick a background refresh; DO NOT await
  refreshFromFeed().catch(() => {});
  initDone = true;
}

async function refreshIfStale() {
  const now = Date.now();
  if (!lastRefresh || (REFRESH_MS > 0 && (now - lastRefresh) > REFRESH_MS)) {
    await refreshFromFeed();
  }
}

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
  // Ensure Node runtime and fast fail CORS preflight (optional)
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.statusCode = 204; return res.end();
  }
  res.setHeader("access-control-allow-origin", "*");

  ensureInit();                // non-blocking
  refreshIfStale().catch(() => {}); // background

  // Parse path
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;   // e.g. /api/articles or /api/articles/123

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

  // POST /api/articles
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
    cache.articles = [...normalized, ...cache.articles];

    // Fire-and-forget forward
    if (N8N_WEBHOOK_URL) {
      fetchJSON(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalized.length === 1 ? normalized[0] : normalized),
        timeoutMs: 1500
      }).catch(() => {});
    }

    return json(res, 201, {
      inserted: normalized.length,
      items: normalized,
      forward: { forwarded: !!N8N_WEBHOOK_URL }
    });
  }

  // Fallback
  return json(res, 404, { error: "Not found" });
};

// Ensure Node runtime + short max duration
module.exports.config = { runtime: "nodejs18.x", maxDuration: 10 };
