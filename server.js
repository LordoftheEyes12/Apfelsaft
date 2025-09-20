const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const { randomUUID } = require('crypto');
const slugify = require('slugify');
const dayjs = require('dayjs');

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'articles.json');

// --- Ensure data dir/file exists ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

// --- Helpers: load/save ---
function loadArticles() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read data file:', e);
    return [];
  }
}

function saveArticles(articles) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(articles, null, 2));
}

// --- Express setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet());
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Homepage: list of articles ---
app.get('/', (req, res) => {
  const articles = loadArticles().sort((a, b) => b.createdAt - a.createdAt);
  res.render('index', { articles, dayjs });
});

// --- Article detail page ---
app.get('/article/:slug', (req, res, next) => {
  const { slug } = req.params;
  const articles = loadArticles();
  const article = articles.find(a => a.slug === slug);
  if (!article) return next(); // 404
  res.render('article', { article, dayjs });
});

// --- Simple about subpage ---
app.get('/about', (req, res) => {
  res.render('about');
});

// --- API: create article (no auth, headline + content only) ---
/**
 * POST /api/articles
 * Body (JSON): { headline: string, content: string }
 * Returns: { id, slug, url }
 */
app.post('/api/articles', (req, res) => {
  const { headline, content } = req.body || {};

  if (!headline || !content || typeof headline !== 'string' || typeof content !== 'string') {
    return res.status(400).json({
      error: "Invalid payload. Expected JSON with 'headline' (string) and 'content' (string)."
    });
  }

  const id = randomUUID();
  const slugBase = slugify(headline, { lower: true, strict: true });
  const slug = `${slugBase}-${id.slice(0, 8)}`;
  const createdAt = Date.now();

  const newArticle = {
    id,
    slug,
    headline: headline.trim(),
    content: content.trim(),
    createdAt
  };

  const articles = loadArticles();
  articles.push(newArticle);
  saveArticles(articles);

  return res.status(201).json({ id, slug, url: `/article/${slug}` });
});

// --- API: list articles (optional) ---
app.get('/api/articles', (req, res) => {
  const articles = loadArticles()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(a => ({
      id: a.id,
      slug: a.slug,
      headline: a.headline,
      createdAt: a.createdAt,
      url: `/article/${a.slug}`
    }));
  res.json({ articles });
});

// --- 404 & error handlers ---
app.use((req, res) => {
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) {
    res.status(500).json({ error: 'Internal Server Error' });
  } else {
    res.status(500).render('500');
  }
});

app.listen(PORT, () => {
  console.log(`News site running on http://localhost:${PORT}`);
  console.log('POST articles to /api/articles (no auth).');
});
