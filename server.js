// server.js — no EJS, static frontend + JSON API
const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON for inbound POSTs (if you push data in)
app.use(express.json());

// Static assets
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Simple data store (file-based for demo)
const DATA_FILE = path.join(__dirname, "data", "articles.json");

// Ensure data file exists
function readArticles() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { articles: [] };
  }
}
function writeArticles(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

// ---------- API ----------
app.get("/api/articles", (req, res) => {
  const { articles } = readArticles();
  res.json({ articles });
});

app.get("/api/articles/:id", (req, res) => {
  const { id } = req.params;
  const { articles } = readArticles();
  const item = articles.find(a => String(a.id ?? a.index ?? a._id) === String(id));
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

// Accept new/updated articles via POST (optional)
app.post("/api/articles", (req, res) => {
  const payload = req.body;
  if (!payload) return res.status(400).json({ error: "Missing body" });

  const db = readArticles();
  const nextId = (() => {
    const ids = db.articles.map(a => Number(a.id ?? a.index ?? 0)).filter(n => !Number.isNaN(n));
    return (Math.max(0, ...ids) + 1);
  })();

  // Accept a single article or an array
  const toInsert = Array.isArray(payload) ? payload : [payload];
  const normalized = toInsert.map((a, i) => ({
    id: a.id ?? a.index ?? (nextId + i),
    headline: a.headline ?? a.title ?? "Untitled",
    content: a.content ?? "",
    createdAt: a.createdAt ?? new Date().toISOString()
  }));

  db.articles.unshift(...normalized);
  writeArticles(db);

  res.status(201).json({ inserted: normalized.length, items: normalized });
});

// ---------- Frontend routes (serve static files) ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/article/:id", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "article.html"));
});

// 404 for anything else not handled above
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
