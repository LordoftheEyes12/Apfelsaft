// server.js — read-only FS safe, Vercel-friendly (no top-level await, no listen)
const path = require("path");
const express = require("express");

const app = express();

// ====== CONFIG ======
const PORT = process.env.PORT || 3000; // used only for local dev
const PUBLIC_DIR = path.join(__dirname, "public");
const N8N_FEED_URL = process.env.N8N_FEED_URL || "";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const REFRESH_MS = Number(process.env.REFRESH_MS || 60_000); // cache staleness window

// ====== STATE (in-memory, ephemeral) ======
let cache = { articles: [] };
let lastRefresh = 0;
let seeded = false;

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

async function seedFromEnvJSON() {
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

async function refreshFromFeed() {
  if (!N8N_FEED_URL) return;
  try {
    const res = await fetch(N8N_FEED_URL);
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.articles || []);
    const normalized = normalizeArray(list);
    const byId = new Map(normalized.map(a => [String(a.id), a]));
    // keep any local-only items
    cache.articles.forEach(a => {
      const key = String(a.id);
      if (!byId.has(key)) byId.set(key, a);
    });
    cache.articles = Array.from(byId.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } finally {
    lastRefresh = Date.now();
  }
}

// Lazy, one-time init without top-level await
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      if (!seeded) { await seedFromEnvJSON(); seeded = true; }
      await refreshFromFeed();
    })().catch(() => { /* swallow init errors; serve whatever we have */ });
  }
  return initPromise;
}

// Optionally refresh on demand if stale (no setInterval in serverless)
async function refreshIfStale() {
  const now = Date.now();
  if (!lastRefresh || (REFRESH_MS > 0 && (now - lastRefresh) > REFRESH_MS)) {
    try { await refreshFromFeed(); } catch {}
  }
}

// ====== MIDDLEWARE ======
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// ====== API ======
app.get("/api/health", async (_req, res) => {
  await ensureInit();
  await refreshIfStale();
  res.json({
    ok: true,
    articles: cache.articles.length,
    source: N8N_FEED_URL ? "feed" : (process.env.ARTICLES_JSON ? "env" : "memory"),
    lastRefresh
  });
});

app.get("/api/articles", async (_req, res) => {
  await ensureInit();
  await refreshIfStale();
  res.json({ articles: cache.articles });
});

app.get("/api/articles/:id", async (req, res) => {
  await ensureInit();
  await refreshIfStale();
  const id = String(req.params.id);
  const item = cache.articles.find(a => String(a.id) === id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

app.post("/api/articles", async (req, res) => {
  await ensureInit();
  const payload = req.body;
  if (!payload) return res.status(400).json({ error: "Missing body" });

  const normalized = normalizeArray(payload);
  cache.articles = [...normalized, ...cache.articles];

  let forward = { forwarded: false };
  if (N8N_WEBHOOK_URL) {
    try {
      const fw = await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalized.length === 1 ? normalized[0] : normalized)
      });
      forward = { forwarded: true, status: fw.status };
    } catch {
      forward = { forwarded: false, error: "forward_failed" };
    }
  }

  res.status(201).json({ inserted: normalized.length, items: normalized, forward });
});

// Static pages
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/article/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "article.html")));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

// Local dev: run a server only when invoked directly
if (require.main === module) {
  app.listen(PORT, () => console.log(`http://localhost:${PORT} (read-only safe)`));
}

// Export the app for serverless adapters (Vercel)
module.exports = app;
