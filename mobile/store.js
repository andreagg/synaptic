// Sostituto mobile di src/db.js: stessa API sincrona di Books/Chapters, dati in memoria
// salvati su IndexedDB (con debounce). Va inizializzato con `await initStore()`.
import { idbGet, idbSet } from './idb.js';

export const DATA_DIR = null;
let state = { seq: 0, books: [], chapters: [] };
let saveTimer = null;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbSet('kv', 'state', state).catch((e) => console.error('salvataggio fallito', e));
    window.dispatchEvent(new CustomEvent('synaptic:store'));
  }, 250);
};

export async function initStore() {
  const saved = await idbGet('kv', 'state').catch(() => null);
  if (saved?.books) state = saved;
}

const id = () => ++state.seq;
const copy = (o) => (o ? structuredClone(o) : o);
const bySort = (a, b) => a.sort_key - b.sort_key || a.id - b.id;
const chaptersOf = (bookId) => state.chapters.filter((c) => c.book_id === Number(bookId));

export const Books = {
  list() {
    return [...state.books].sort((a, b) => b.created_at - a.created_at).map((b) => {
      const chs = chaptersOf(b.id);
      return { ...copy(b), chapter_count: chs.length, new_count: chs.filter((c) => c.is_new).length,
        read_count: chs.filter((c) => c.read_at).length };
    });
  },
  get(bid) { return copy(state.books.find((b) => b.id === Number(bid))); },
  byUrl(url) { return copy(state.books.find((b) => b.source_url === url)); },
  create({ title, source_url, use_ai = true, render_js = false, update_hours = 24 }) {
    if (state.books.some((b) => b.source_url === source_url)) throw new Error('Fonte già presente');
    const b = { id: id(), title, source_url, cover: null, description: null, kind: 'unknown', status: 'idle',
      message: null, rules: null, use_ai: !!use_ai, render_js: !!render_js, update_hours, last_checked: null, created_at: Date.now() };
    state.books.push(b); persist();
    return copy(b);
  },
  update(bid, fields) {
    const b = state.books.find((x) => x.id === Number(bid));
    if (!b) return null;
    const allowed = ['title', 'cover', 'description', 'kind', 'status', 'message', 'rules', 'use_ai', 'render_js', 'update_hours', 'last_checked'];
    for (const k of allowed) if (fields[k] !== undefined) b[k] = copy(fields[k]);
    persist();
    return copy(b);
  },
  remove(bid) {
    state.books = state.books.filter((b) => b.id !== Number(bid));
    state.chapters = state.chapters.filter((c) => c.book_id !== Number(bid));
    persist();
  },
  due(now = Date.now()) {
    return state.books.filter((b) => b.update_hours > 0 && !['scanning', 'downloading'].includes(b.status)
      && (!b.last_checked || b.last_checked + b.update_hours * 3600000 <= now)).map(copy);
  },
};

export const Chapters = {
  list(bookId) { return chaptersOf(bookId).sort(bySort).map(({ content, ...c }) => copy(c)); },
  get(cid) { return copy(state.chapters.find((c) => c.id === Number(cid))); },
  upsertMany(bookId, items, { markNew = true } = {}) {
    const known = new Set(chaptersOf(bookId).map((c) => c.url));
    let added = 0;
    for (const it of items) {
      if (known.has(it.url)) continue;
      known.add(it.url);
      const ready = it.type && it.type !== 'page';
      state.chapters.push({ id: id(), book_id: Number(bookId), sort_key: it.sort_key ?? 0, title: it.title, url: it.url,
        type: it.type || 'page', status: ready ? 'ready' : 'pending', content: copy(it.content) ?? null,
        is_new: !!markNew, read_at: null, progress: 0, error: null, created_at: Date.now() });
      added++;
    }
    if (added) persist();
    return added;
  },
  update(cid, fields) {
    const c = state.chapters.find((x) => x.id === Number(cid));
    if (!c) return;
    for (const k of ['title', 'type', 'status', 'content', 'is_new', 'read_at', 'progress', 'error']) {
      if (fields[k] !== undefined) c[k] = copy(fields[k]);
    }
    persist();
  },
  neighbours(ch) {
    const list = chaptersOf(ch.book_id).sort(bySort);
    const i = list.findIndex((c) => c.id === ch.id);
    const pick = (c) => (c ? { id: c.id, title: c.title } : null);
    return { prev: pick(list[i - 1]), next: pick(list[i + 1]) };
  },
  remove(cid) { state.chapters = state.chapters.filter((c) => c.id !== Number(cid)); persist(); },
  clearNew(bookId) { for (const c of chaptersOf(bookId)) c.is_new = false; persist(); },
  pending(bookId) { return chaptersOf(bookId).filter((c) => c.status !== 'ready').sort(bySort).map(copy); },
  ready(bookId) { return chaptersOf(bookId).filter((c) => c.status === 'ready').sort(bySort).map(copy); },
};
