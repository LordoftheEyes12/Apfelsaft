// server.js — read-only FS safe: no writes, no EJS.
// Node 18+ required (uses global fetch).

const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CONFIG (env) ======
const PUBLIC_DIR = path.join(__dirname, "public");
// Optional: external GET feed to seed/refresh cache
const N8N_FEED_URL = process.env.N8N_FEED_URL || ""; // e.g., https://n8n.example.com/webhook/get-articles
// Optional: external POST webhook to persist new articles
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ""; // e.g., https://n8n.example.com/webhook/new-article
// Optional: JSON seed in env if you have no feed
// ARTICLES_JSON='{"articles":[{"id":1,"headline":"Hello","content":"World"}]}'

// ====== STATE (in-memory, ephemeral) ======
let cache = {
  articles: []
};

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
    if (Array.isArray(json)) cache.articles = normalizeArray(json);
    else if (Array.isArray(json.articles)) cache.articles = normalizeArray(json.articles);
  } catch {
    // ignore malformed env
  }
}

async function refreshFromFeed() {
  if (!N8N_FEED_URL) return;
  try {
    const res = await fetch(N8N_FEED_URL, { method: "GET" });
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.articles || []);
    const normalized = normalizeArray(list);
    // Basic dedupe by id (prefer latest from feed)
    const byId = new Map();
    normalized.forEach(a => byId.set(String(a.id), a));
    // Also keep any local-only items that aren't in feed
    cache.articles.forEach(a => {
      const key = String(a.id);
      if (!byId.has(key)) byId.set(key, a);
    });
    cache.articles = Array.from(byId.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    // fail silently; we just keep existing cache
  }
}

// Seed once at boot
await seedFromEnvJSON();
await refreshFromFeed();
// Optional: periodic refresh (read-only safe)
const REFRESH_MS = Number(process.env.REFRESH_MS || 60_000); // 1 min default
if (N8N_FEED_URL && REFRESH_MS > 0) setInterval(refreshFromFeed, REFRESH_MS);

// ====== MIDDLEWARE ======
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// ====== API ======
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, articles: cache.articles.length, source: N8N_FEED_URL ? "feed" : (process.env.ARTICLES_JSON ? "env" : "memory") });
});

app.get("/api/articles", (_req, res) => {
  res.json({ articles: cache.articles });
});

app.get("/api/articles/:id", (req, res) => {
  const id = String(req.params.id);
  const item = cache.articles.find(a => String(a.id) === id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

// Accept inbound data even on read-only FS by:
// 1) updating in-memory cache (ephemeral)
// 2) optionally forwarding to an external webhook for persistence
app.post("/api/articles", async (req, res) => {
  const payload = req.body;
  if (!payload) return res.status(400).json({ error: "Missing body" });

  const normalized = normalizeArray(payload);

  // Update in-memory (no disk writes)
  // Put newest first
  cache.articles = [...normalized, ...cache.articles];

  // Fire-and-forget forward to external webhook (if configured)
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

// Fallback to SPA/static pages
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
app.get("/article/:id", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "article.html"));
});

// 404 for unknown API routes; otherwise serve 404 page
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (read-only safe)`);
});
