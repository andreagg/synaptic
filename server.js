import express from 'express';
import path from 'node:path';
import { Books, Chapters } from './src/db.js';
import { addSource, scanBook, resolveChapterNow, downloadBook, isBusy, queueDownload, queuedIds } from './src/engine/engine.js';
import { aiAvailable } from './src/engine/ai.js';
import { getMedia } from './src/fetcher.js';
import { startScheduler } from './src/scheduler.js';

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});
const bookOr404 = (req, res) => {
  const b = Books.get(Number(req.params.id));
  if (!b) res.status(404).json({ error: 'Libro non trovato' });
  return b;
};

app.get('/api/status', (req, res) => res.json({ ai: aiAvailable() }));

app.get('/api/books', (req, res) => res.json(Books.list().map((b) => ({ ...b, busy: isBusy(b.id) }))));

app.post('/api/books', wrap(async (req, res) => {
  const { url, title, use_ai, render_js, update_hours } = req.body || {};
  try { new URL(url); } catch { return res.status(400).json({ error: 'URL non valido' }); }
  res.status(201).json(await addSource({ url, title, use_ai, render_js, update_hours: Number(update_hours ?? 24) }));
}));

app.get('/api/books/:id', (req, res) => {
  const b = bookOr404(req, res); if (!b) return;
  res.json({ ...b, busy: isBusy(b.id), queued: queuedIds(b.id), chapters: Chapters.list(b.id) });
});

app.patch('/api/books/:id', (req, res) => {
  const b = bookOr404(req, res); if (!b) return;
  const { title, update_hours, use_ai, render_js, rules } = req.body || {};
  res.json(Books.update(b.id, { title, update_hours, use_ai, render_js, rules }));
});

app.delete('/api/books/:id', (req, res) => {
  const b = bookOr404(req, res); if (!b) return;
  Books.remove(b.id); res.status(204).end();
});

app.post('/api/books/:id/scan', (req, res) => {
  const b = bookOr404(req, res); if (!b) return;
  scanBook(b.id).catch(() => {}); res.status(202).json({ ok: true });
});
app.post('/api/books/:id/download', (req, res) => {
  const b = bookOr404(req, res); if (!b) return;
  const ids = req.body?.chapters;
  if (Array.isArray(ids)) {
    const list = req.body.prefetch ? ids.filter((id) => !Chapters.get(Number(id))?.meta?.offline) : ids;
    return res.status(202).json({ queued: list.length ? queueDownload(b.id, list) : 0 });
  }
  downloadBook(b.id).catch(() => {}); res.status(202).json({ ok: true });
});
app.post('/api/books/:id/seen', (req, res) => {
  const b = bookOr404(req, res); if (!b) return;
  Chapters.clearNew(b.id); res.json({ ok: true });
});

app.get('/api/chapters/:id', wrap(async (req, res) => {
  let ch = Chapters.get(Number(req.params.id));
  if (!ch) return res.status(404).json({ error: 'Capitolo non trovato' });
  if (ch.status !== 'ready' || req.query.refresh) {
    try { ch = await resolveChapterNow(ch.id, { force: !!req.query.refresh }); }
    catch (e) { return res.status(422).json({ error: e.message, chapter: Chapters.get(ch.id) }); }
  }
  if (!ch) return res.status(404).json({ error: 'Capitolo riorganizzato, ricarica il libro' });
  const book = Books.get(ch.book_id);
  res.json({ ...ch, book: { id: book.id, title: book.title }, ...Chapters.neighbours(ch) });
}));

app.post('/api/chapters/:id/progress', (req, res) => {
  const ch = Chapters.get(Number(req.params.id));
  if (!ch) return res.status(404).end();
  Chapters.update(ch.id, { progress: Number(req.body?.progress) || 0, read_at: Date.now(), is_new: false });
  res.json({ ok: true });
});

// Proxy dei media con cache su disco: evita blocchi hotlink e abilita la lettura offline.
app.get('/api/media', wrap(async (req, res) => {
  const { u, ref } = req.query;
  if (!u || !/^https?:\/\//.test(u)) return res.status(400).end();
  const { file, type } = await getMedia(u, ref);
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
}));

app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.resolve('public/index.html')));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`📚 Libreria pronta su http://localhost:${PORT}  (AI: ${aiAvailable() ? 'attiva' : 'non configurata'})`);
  startScheduler();
});
