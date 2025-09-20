// server.js — read-only FS safe, Vercel-friendly Express app
// - No top-level await
// - No disk writes
// - Non-blocking init + short timeouts for outbound fetch
// - Exported app for serverless; app.listen only in local dev

const path = require("path");
const express = require("express");

const app = express();

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;              // used only for local dev
const PUBLIC_DIR = path.join(__dirname, "public");
const N8N_FEED_URL = process.env.N8N_FEED_URL || "";     // optional GET seed
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ""; // optional POST forward
const REFRESH_MS = Number(process.env.REFRESH_MS || 60_000); // refresh window

// ====== STATE (ephemeral) ======
let cache = { articles: [] };
let lastRefresh = 0;
let seeded = false;
let initDone = false;

// ====== HELPERS ======
function normalizeArray(input) {
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((a, i) => ({
    id: a.id ?? a.index ?? a._id ?? `${Date.now()}-${i}`,
    headline: a.headline ?? a.title ?? "Untitled",
    content: a.content ?? "",
    createdAt: a.createdAt ?? new Date().toISOString()
  }));
}

// Fast, safe fetch with timeout
function fetchJSON(url, { timeoutMs = 2000, ...opts } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ac.signal })
    .finally(() => clearTimeout(t));
}

// Seed from env (sync; no awaits here)
function seedFromEnvJSON() {
  try {
    const raw = process.env.ARTICLES_JSON;
    if (!raw) return;
    const json = JSON.parse(raw);
    const list = Array.isArray(json) ? json : (json.articles || []);
    cache.articles = normalizeArray(list);
  } catch {
    /* ignore malformed env */
  }
}

// Refresh from external feed (timeout-protected)
async function refreshFromFeed() {
  if (!N8N_FEED_URL) { lastRefresh = Date.now(); return; }
  try {
    const res = await fetchJSON(N8N_FEED_URL, { timeoutMs: 2000 });
    if (!res.ok) { lastRefresh = Date.now(); return; }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.articles || []);
    const normalized = normalizeArray(list);

    // Deduplicate by id, keep local-only items
    const byId = new Map(normalized.map(a => [String(a.id), a]));
    cache.articles.forEach(a => {
      const key = String(a.id);
      if (!byId.has(key)) byId.set(key, a);
    });

    cache.articles = Array.from(byId.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    // swallow; we'll try again later
  } finally {
    lastRefresh = Date.now();
  }
}

// Non-blocking, one-time init (no awaits)
function ensureInit() {
  if (initDone) return;
  if (!seeded) { seedFromEnvJSON(); seeded = true; }
  // Kick off a background refresh; do NOT await
  refreshFromFeed().catch(() => {});
  initDone = true;
}

// Refresh if cache is stale (call without await in handlers)
async function refreshIfStale() {
  const now = Date.now();
  if (!lastRefresh || (REFRESH_MS > 0 && (now - lastRefresh) > REFRESH_MS)) {
    await refreshFromFeed(); // already timeout-protected
  }
}

// ====== MIDDLEWARE ======
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// ====== API ======
app.get("/api/health", (_req, res) => {
  ensureInit();
  refreshIfStale().catch(() => {});
  res.json({
    ok: true,
    articles: cache.articles.length,
    source: N8N_FEED_URL ? "feed" : (process.env.ARTICLES_JSON ? "env" : "memory"),
    lastRefresh
  });
});

app.get("/api/articles", (_req, res) => {
  ensureInit();
  refreshIfStale().catch(() => {});
  res.json({ articles: cache.articles });
});

app.get("/api/articles/:id", (req, res) => {
  ensureInit();
  refreshIfStale().catch(() => {});
  const id = String(req.params.id);
  const item = cache.articles.find(a => String(a.id) === id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

app.post("/api/articles", (req, res) => {
  ensureInit();
  const payload = req.body;
  if (!payload) return res.status(400).json({ error: "Missing body" });

  const normalized = normalizeArray(payload);
  cache.articles = [...normalized, ...cache.articles];

  // Fire-and-forget forwarding to external persistence
  if (N8N_WEBHOOK_URL) {
    fetchJSON(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(normalized.length === 1 ? normalized[0] : normalized),
      timeoutMs: 1500
    }).catch(() => {});
  }

  res.status(201).json({
    inserted: normalized.length,
    items: normalized,
    forward: { forwarded: !!N8N_WEBHOOK_URL }
  });
});

// ====== STATIC PAGES ======
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/article/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "article.html")));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

// ====== LOCAL DEV ONLY ======
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Local dev: http://localhost:${PORT} (read-only safe)`);
  });
}

// ====== EXPORT FOR SERVERLESS (Vercel) ======
module.exports = app;
