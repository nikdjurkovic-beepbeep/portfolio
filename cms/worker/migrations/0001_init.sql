-- NikolaSEO CMS schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('administrator','editor','author','contributor','subscriber')),
  caps TEXT NOT NULL DEFAULT '{}',            -- {"grant":[...],"revoke":[...]}
  pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  reset_hash TEXT, reset_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,                  -- repository path, e.g. seo-myths/index.html
  url TEXT NOT NULL UNIQUE,                   -- public URL path, e.g. /seo-myths/
  title TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT 'basic',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','scheduled','trash')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','password')),
  password_hash TEXT,
  parent_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  menu_order INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  live_sha TEXT,                              -- blob sha of the public file on GitHub (public + published)
  base_sha TEXT,                              -- live sha the current draft was started from
  draft_html TEXT,                            -- full HTML of unpublished changes (never in the repo)
  published_html TEXT,                        -- last published HTML (served by the Worker for private/password pages)
  seo TEXT NOT NULL DEFAULT '{}',             -- SEO settings (JSON)
  sitemap INTEGER NOT NULL DEFAULT 1,
  breadcrumbs INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  lock_user INTEGER, lock_until TEXT,
  trashed_from TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pages_status ON pages(status, visibility);
CREATE INDEX IF NOT EXISTS pages_sched ON pages(status, scheduled_at);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('autosave','draft','publish','restore','import','unpublish')),
  title TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL,
  seo TEXT NOT NULL DEFAULT '{}',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  page_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS revisions_page ON revisions(page_id, id DESC);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taxonomy TEXT NOT NULL CHECK (taxonomy IN ('category','tag')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  UNIQUE (taxonomy, slug)
);
CREATE TABLE IF NOT EXISTS page_terms (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, term_id)
);

CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  target TEXT NOT NULL,
  code INTEGER NOT NULL DEFAULT 301 CHECK (code IN (301,302,303,307,308)),
  match TEXT NOT NULL DEFAULT 'exact' CHECK (match IN ('exact','wildcard','regex')),
  query TEXT NOT NULL DEFAULT 'pass' CHECK (query IN ('exact','ignore','pass')),
  ignore_case INTEGER NOT NULL DEFAULT 1,
  ignore_slash INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS redirects_key ON redirects(source_key);

CREATE TABLE IF NOT EXISTS redirect_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  data TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  path TEXT PRIMARY KEY,
  sha TEXT,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  width INTEGER, height INTEGER,
  title TEXT NOT NULL DEFAULT '',
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  collection TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT UNIQUE,                       -- 'primary' renders into the site header
  items TEXT NOT NULL DEFAULT '[]',
  published_items TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(id DESC);

INSERT OR IGNORE INTO settings (key, value) VALUES ('redirects_version', '1'), ('content_version', '1'), ('schema_version', '1');
