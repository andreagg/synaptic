// Persistenza su SQLite (modulo nativo node:sqlite, nessuna build nativa richiesta).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  source_url    TEXT NOT NULL UNIQUE,
  cover         TEXT,
  description   TEXT,
  kind          TEXT DEFAULT 'unknown',     -- manga | pdf | article | mixed | unknown
  status        TEXT DEFAULT 'idle',        -- idle | scanning | downloading | error
  message       TEXT,
  rules         TEXT,                       -- JSON: regole apprese (pattern capitoli/immagini)
  use_ai        INTEGER DEFAULT 1,
  render_js     INTEGER DEFAULT 0,
  update_hours  REAL DEFAULT 24,
  last_checked  INTEGER,
  created_at    INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS chapters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sort_key    REAL NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  type        TEXT DEFAULT 'page',          -- page (da risolvere) | images | pdf | file | html
  status      TEXT DEFAULT 'pending',       -- pending | ready | error
  content     TEXT,                         -- JSON col contenuto risolto
  is_new      INTEGER DEFAULT 0,
  read_at     INTEGER,
  progress    REAL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER DEFAULT (unixepoch() * 1000),
  UNIQUE(book_id, url)
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, sort_key);
`);
// migrazione: metadati del capitolo (es. volume)
if (!db.prepare("SELECT 1 FROM pragma_table_info('chapters') WHERE name = 'meta'").get()) {
  db.exec('ALTER TABLE chapters ADD COLUMN meta TEXT');
}

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function hydrateBook(b) {
  if (!b) return b;
  return { ...b, rules: parse(b.rules), use_ai: !!b.use_ai, render_js: !!b.render_js };
}
function hydrateChapter(c) {
  if (!c) return c;
  return { ...c, content: parse(c.content), meta: parse(c.meta), is_new: !!c.is_new };
}

export const Books = {
  list() {
    return db.prepare(`
      SELECT b.*,
        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id AND c.is_new = 1) AS new_count,
        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id AND c.read_at IS NOT NULL) AS read_count
      FROM books b ORDER BY b.created_at DESC`).all().map(hydrateBook);
  },
  get(id) { return hydrateBook(db.prepare('SELECT * FROM books WHERE id = ?').get(id)); },
  byUrl(url) { return hydrateBook(db.prepare('SELECT * FROM books WHERE source_url = ?').get(url)); },
  create({ title, source_url, use_ai = true, render_js = false, update_hours = 24 }) {
    const r = db.prepare(`INSERT INTO books (title, source_url, use_ai, render_js, update_hours)
      VALUES (?, ?, ?, ?, ?)`).run(title, source_url, use_ai ? 1 : 0, render_js ? 1 : 0, update_hours);
    return this.get(Number(r.lastInsertRowid));
  },
  update(id, fields) {
    const allowed = ['title', 'cover', 'description', 'kind', 'status', 'message', 'rules',
      'use_ai', 'render_js', 'update_hours', 'last_checked'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return this.get(id);
    const vals = keys.map((k) => {
      const v = fields[k];
      if (k === 'rules') return json(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v ?? null;
    });
    db.prepare(`UPDATE books SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  },
  remove(id) { db.prepare('DELETE FROM books WHERE id = ?').run(id); },
  due(now = Date.now()) {
    return db.prepare(`SELECT * FROM books WHERE update_hours > 0 AND status NOT IN ('scanning','downloading')
      AND (last_checked IS NULL OR last_checked + update_hours * 3600000 <= ?)`).all(now).map(hydrateBook);
  },
};

export const Chapters = {
  list(bookId) {
    return db.prepare(`SELECT id, book_id, sort_key, title, url, type, status, is_new, read_at, progress, error,
      meta, created_at FROM chapters WHERE book_id = ? ORDER BY sort_key, id`).all(bookId).map(hydrateChapter);
  },
  get(id) { return hydrateChapter(db.prepare('SELECT * FROM chapters WHERE id = ?').get(id)); },
  /** Inserisce i capitoli non ancora presenti; restituisce quanti sono nuovi. */
  upsertMany(bookId, items, { markNew = true } = {}) {
    const ins = db.prepare(`INSERT OR IGNORE INTO chapters (book_id, sort_key, title, url, type, status, content, is_new, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const fillMeta = db.prepare('UPDATE chapters SET meta = ? WHERE book_id = ? AND url = ? AND meta IS NULL');
    let added = 0;
    db.exec('BEGIN');
    try {
      for (const it of items) {
        const ready = it.type && it.type !== 'page';
        const r = ins.run(bookId, it.sort_key ?? 0, it.title, it.url, it.type || 'page',
          ready ? 'ready' : 'pending', json(it.content), markNew ? 1 : 0, json(it.meta));
        added += Number(r.changes);
        if (!r.changes && it.meta) fillMeta.run(json(it.meta), bookId, it.url);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return added;
  },
  update(id, fields) {
    const allowed = ['title', 'type', 'status', 'content', 'is_new', 'read_at', 'progress', 'error', 'meta'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const vals = keys.map((k) => {
      const v = fields[k];
      if (k === 'content' || k === 'meta') return json(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v ?? null;
    });
    db.prepare(`UPDATE chapters SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  },
  neighbours(ch) {
    const prev = db.prepare(`SELECT id, title, status, meta FROM chapters WHERE book_id = ? AND (sort_key < ? OR (sort_key = ? AND id < ?))
      ORDER BY sort_key DESC, id DESC LIMIT 1`).get(ch.book_id, ch.sort_key, ch.sort_key, ch.id);
    const next = db.prepare(`SELECT id, title, status, meta FROM chapters WHERE book_id = ? AND (sort_key > ? OR (sort_key = ? AND id > ?))
      ORDER BY sort_key, id LIMIT 1`).get(ch.book_id, ch.sort_key, ch.sort_key, ch.id);
    const h = (c) => (c ? { ...c, meta: parse(c.meta) } : null);
    return { prev: h(prev), next: h(next) };
  },
  remove(id) { db.prepare('DELETE FROM chapters WHERE id = ?').run(id); },
  clearNew(bookId) { db.prepare('UPDATE chapters SET is_new = 0 WHERE book_id = ?').run(bookId); },
  pending(bookId) {
    return db.prepare(`SELECT * FROM chapters WHERE book_id = ? AND status != 'ready' ORDER BY sort_key, id`)
      .all(bookId).map(hydrateChapter);
  },
  ready(bookId) {
    return db.prepare(`SELECT * FROM chapters WHERE book_id = ? AND status = 'ready' ORDER BY sort_key, id`)
      .all(bookId).map(hydrateChapter);
  },
};
