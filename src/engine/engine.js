// Motore: orchestra scansione delle fonti, risoluzione dei capitoli, download offline.
import { Books, Chapters } from '../db.js';
import { fetchPage, getMedia, isCached, probeUrl } from '../fetcher.js';
import {
  load, pageMeta, findChapterList, findFiles, findImages, findReaderPages,
  findNextLink, extractArticle, summarizeForAI, signature, FILE_EXT, isNumericName,
} from './analyze.js';
import { analyzeWithAI, aiAvailable } from './ai.js';

const MAX_INDEX_PAGES = 60;
const MAX_READER_PAGES = 400;
const running = new Map(); // bookId -> Promise (una operazione per libro alla volta)

const log = (book, msg) => { console.log(`[${book.id}] ${msg}`); Books.update(book.id, { message: msg }); };

function exclusive(bookId, fn) {
  if (running.has(bookId)) return running.get(bookId);
  const p = fn().finally(() => running.delete(bookId));
  running.set(bookId, p);
  return p;
}
export const isBusy = (bookId) => running.has(bookId);

function fileType(url, contentType = '') {
  if (/pdf/i.test(contentType) || /\.pdf(\?|#|$)/i.test(url)) return 'pdf';
  if (/^image\//i.test(contentType)) return 'images';
  return 'file';
}
const fileChapter = (f, i) => {
  const type = fileType(f.url);
  return { title: f.title, url: f.url, sort_key: f.sort_key ?? i, type, content: type === 'images' ? { images: [f.url] } : { url: f.url } };
};

// ---------------------------------------------------------------------------
// 1. Aggiunta di una fonte
// ---------------------------------------------------------------------------
export async function addSource({ url, title, use_ai = true, render_js = false, update_hours = 24 }) {
  const u = new URL(url).href;
  const existing = Books.byUrl(u);
  if (existing) return existing;
  const book = Books.create({ title: title || u, source_url: u, use_ai, render_js, update_hours });
  scanBook(book.id).catch((e) => console.error(e));
  return book;
}

// ---------------------------------------------------------------------------
// 2. Scansione: trova l'elenco dei contenuti (e i nuovi capitoli)
// ---------------------------------------------------------------------------
export function scanBook(bookId) {
  return exclusive(bookId, async () => {
    let book = Books.get(bookId);
    if (!book) return;
    const hadChapters = Chapters.list(bookId).length > 0;
    Books.update(bookId, { status: 'scanning', message: 'Analisi della fonte…' });
    try {
      const found = await discover(book);
      book = Books.get(bookId);
      const added = Chapters.upsertMany(bookId, found.items, { markNew: hadChapters });
      const patch = { status: 'idle', last_checked: Date.now(), kind: found.kind || book.kind };
      if (found.rules) patch.rules = { ...(book.rules || {}), ...found.rules };
      if ((book.title === book.source_url || !book.title) && found.meta?.title) patch.title = found.meta.title;
      if (!book.cover && found.meta?.cover) patch.cover = found.meta.cover;
      if (!book.description && found.meta?.description) patch.description = found.meta.description;
      patch.message = hadChapters
        ? (added ? `${added} nuovi contenuti trovati` : 'Nessun aggiornamento')
        : `${found.items.length} contenuti trovati (${found.via})`;
      Books.update(bookId, patch);
      log(book, patch.message);

      // risolvi subito il primo capitolo: serve per copertina e tipo
      const first = Chapters.list(bookId)[0];
      if (first && first.status !== 'ready') await resolveChapterNow(first.id).catch(() => {});
      await fillCover(bookId);
      Books.update(bookId, { message: patch.message });
      return { added, total: found.items.length };
    } catch (e) {
      Books.update(bookId, { status: 'error', message: e.message, last_checked: Date.now() });
      console.error(`[${bookId}] scansione fallita:`, e);
      throw e;
    }
  });
}

async function discover(book) {
  const rules = book.rules || {};
  const page = await fetchPage(book.source_url, { render: book.render_js });
  if (!page.html) {
    const type = fileType(page.url, page.contentType);
    return { items: [fileChapter({ title: book.title, url: page.url }, 0)], kind: type === 'pdf' ? 'pdf' : 'mixed', via: 'file diretto' };
  }
  const $ = load(page.html);
  const meta = pageMeta($, page.url);
  const list = findChapterList($, page.url, rules);
  const files = findFiles($, page.url);
  const imgs = findImages(load(page.html), page.html, page.url, rules);
  const article = extractArticle(load(page.html));

  const listGood = list && list.items.length >= 3 && list.confidence >= 0.55;
  const aiOn = book.use_ai && aiAvailable();

  // indice di capitoli (eventualmente paginato)
  if (listGood && !(files.length >= list.items.length)) {
    const items = await crawlIndex(book, page, $, list);
    return { items, meta, rules: { chapterPattern: list.pattern }, kind: 'series', via: list.source === 'rules' ? 'regole salvate' : 'euristica' };
  }
  if (files.length) {
    return { items: files.map(fileChapter), meta, kind: files.every((f) => f.ext === 'pdf') ? 'pdf' : 'mixed', via: 'file' };
  }
  if (imgs.images.length >= 3 && !imgs.single) {
    return { items: [{ title: meta.title || book.title, url: page.url, sort_key: 0, type: 'images', content: { images: imgs.images, referer: page.url } }], meta, kind: 'manga', via: 'lettore' };
  }
  if (aiOn) {
    log(book, 'Caso complesso: chiedo aiuto all\'AI…');
    const ai = await analyzeWithAI(summarizeForAI($, page.html, page.url), 'Pagina iniziale di una fonte da trasformare in libreria');
    const r = fromAI(ai, page.url, meta, book);
    if (r) return r;
  }
  if (list && list.items.length) {
    const items = await crawlIndex(book, page, $, list);
    return { items, meta, rules: { chapterPattern: list.pattern }, kind: 'series', via: 'euristica (bassa confidenza)' };
  }
  if (article.length > 800) {
    return { items: [{ title: meta.title || book.title, url: page.url, sort_key: 0, type: 'html', content: { html: article.html } }], meta, kind: 'article', via: 'articolo' };
  }
  throw new Error(aiOn ? 'Nessun contenuto riconosciuto, nemmeno con l\'AI'
    : 'Nessun contenuto riconosciuto. Attiva l\'AI (ANTHROPIC_API_KEY) o il rendering JS per questo sito.');
}

function fromAI(ai, url, meta, book) {
  const m = { ...meta, title: meta.title || ai.title };
  if (ai.pageType === 'index' && ai.chapters.length) {
    const items = ai.chapters.map((c, i) => ({ title: c.title, url: c.url, sort_key: c.number ?? i }));
    return { items, meta: m, rules: ai.chapterLinkPattern ? { chapterPattern: ai.chapterLinkPattern } : null, kind: 'series', via: 'AI' };
  }
  if (ai.pageType === 'files' && ai.files.length) return { items: ai.files.map(fileChapter), meta: m, kind: 'mixed', via: 'AI' };
  if (ai.pageType === 'reader' && ai.imageUrls.length) {
    return {
      items: [{ title: m.title || book.title, url, sort_key: 0, type: 'page' }],
      meta: m, rules: ai.imagePattern ? { imagePattern: ai.imagePattern } : null, kind: 'manga', via: 'AI',
    };
  }
  return null;
}

/** Segue la paginazione dell'indice raccogliendo tutti i capitoli. */
async function crawlIndex(book, page, $, list) {
  const all = new Map(list.items.map((i) => [i.url, i]));
  let next = findNextLink($, page.url);
  const visited = new Set([page.url]);
  let re = null; try { re = new RegExp(list.pattern, 'i'); } catch { /* ignore */ }
  for (let n = 0; next && !visited.has(next) && n < MAX_INDEX_PAGES; n++) {
    if (re && re.test(next)) break; // il "successivo" è un capitolo, non una pagina d'indice
    visited.add(next);
    log(book, `Indice: pagina ${n + 2}…`);
    const p = await fetchPage(next, { render: book.render_js }).catch(() => null);
    if (!p?.html) break;
    const $$ = load(p.html);
    const more = findChapterList($$, p.url, { chapterPattern: list.pattern });
    const before = all.size;
    for (const it of more?.items || []) if (!all.has(it.url)) all.set(it.url, it);
    if (all.size === before) break;
    next = findNextLink($$, p.url);
  }
  const items = [...all.values()];
  // se i sort_key non sono numeri di capitolo coerenti, rinumeriamo nell'ordine
  return items.sort((a, b) => a.sort_key - b.sort_key);
}

// ---------------------------------------------------------------------------
// 3. Risoluzione di un capitolo: da URL a immagini/PDF/testo
// ---------------------------------------------------------------------------
const resolving = new Map();
export function resolveChapterNow(chapterId, { force = false } = {}) {
  if (resolving.has(chapterId)) return resolving.get(chapterId);
  const p = resolveChapter(chapterId, force).finally(() => resolving.delete(chapterId));
  resolving.set(chapterId, p);
  return p;
}

async function resolveChapter(chapterId, force) {
  const ch = Chapters.get(chapterId);
  if (!ch) throw new Error('Capitolo inesistente');
  if (ch.status === 'ready' && !force) return ch;
  const book = Books.get(ch.book_id);
  try {
    const res = await extractChapter(book, ch);
    if (res.expand) {
      // il "capitolo" era a sua volta un indice (es. pagina di un volume): lo espandiamo
      const items = res.expand.map((it, i) => ({ ...it, sort_key: ch.sort_key + (i + 1) / 10000 }));
      Chapters.upsertMany(book.id, items, { markNew: false });
      Chapters.remove(ch.id);
      const firstNew = Chapters.list(book.id).find((c) => c.url === items[0].url);
      return firstNew ? resolveChapter(firstNew.id, force) : null;
    }
    if (res.rules) Books.update(book.id, { rules: { ...(book.rules || {}), ...res.rules } });
    Chapters.update(ch.id, { type: res.type, content: res.content, status: 'ready', error: null });
    if (book.kind === 'unknown' || book.kind === 'series') {
      Books.update(book.id, { kind: res.type === 'images' ? 'manga' : res.type === 'pdf' ? 'pdf' : res.type === 'html' ? 'article' : 'mixed' });
    }
    return Chapters.get(ch.id);
  } catch (e) {
    Chapters.update(ch.id, { status: 'error', error: e.message });
    throw e;
  }
}

async function extractChapter(book, ch) {
  const rules = book.rules || {};
  if (FILE_EXT.test(ch.url)) return { type: fileType(ch.url), content: { url: ch.url } };
  const page = await fetchPage(ch.url, { render: book.render_js, referer: book.source_url });
  if (!page.html) {
    const type = fileType(page.url, page.contentType);
    return { type, content: type === 'images' ? { images: [page.url] } : { url: page.url } };
  }
  const $ = load(page.html);
  const imgs = findImages($, page.html, page.url, rules);

  // a) tutte le pagine nello stesso HTML
  if (imgs.images.length >= 2 && !imgs.single) {
    return { type: 'images', content: { images: imgs.images, referer: page.url }, rules: rules.imagePattern ? null : { imagePattern: imgs.pattern } };
  }
  // b) PDF / file allegati
  const files = findFiles($, page.url);
  if (files.length === 1) return { type: fileType(files[0].url), content: { url: files[0].url } };
  if (files.length > 1) return { expand: files.map((f) => ({ ...fileChapter(f, 0), sort_key: 0 })) };

  // c) lettore "una pagina alla volta"
  if (imgs.single && isNumericName(imgs.images[0])) {
    // pagine numerate in sequenza (01.jpg, 02.jpg…): le scopriamo provando i numeri successivi
    const seq = await probeSequence(book, imgs.images[0], page.url);
    if (seq.length >= 2) return { type: 'images', content: { images: seq, referer: page.url } };
  }
  if (imgs.single) {
    const multi = await crawlReader(book, page, $, imgs);
    if (multi.length >= 2) return { type: 'images', content: { images: multi, referer: page.url } };
  }

  // d) il capitolo è a sua volta un indice (es. pagina volume → capitoli)
  const sub = findChapterList($, page.url, {});
  if (sub && sub.items.length >= 2 && sub.confidence >= 0.6 && !sub.items.some((i) => i.url === book.source_url)) {
    const known = new Set(Chapters.list(book.id).map((c) => c.url));
    const fresh = sub.items.filter((i) => !known.has(i.url));
    if (fresh.length >= 2 && fresh.length === sub.items.length) return { expand: fresh };
  }

  // e) AI
  if (book.use_ai && aiAvailable()) {
    const ai = await analyzeWithAI(summarizeForAI($, page.html, page.url), `Capitolo "${ch.title}" della serie "${book.title}"`);
    if (ai.pageType === 'reader' && ai.imageUrls.length > 1) {
      return { type: 'images', content: { images: ai.imageUrls, referer: page.url }, rules: ai.imagePattern ? { imagePattern: ai.imagePattern } : null };
    }
    if (ai.pageType === 'reader' && ai.imageUrls.length === 1) {
      const multi = await crawlReader(book, page, $, { images: ai.imageUrls, pattern: ai.imagePattern }, ai.nextPageUrl);
      return { type: 'images', content: { images: multi, referer: page.url }, rules: ai.imagePattern ? { imagePattern: ai.imagePattern } : null };
    }
    if (ai.pageType === 'files' && ai.files.length) return { type: fileType(ai.files[0].url), content: { url: ai.files[0].url } };
  }

  // f) testo
  const art = extractArticle(load(page.html));
  if (art.length > 300) return { type: 'html', content: { html: art.html } };
  if (imgs.images.length === 1) return { type: 'images', content: { images: imgs.images, referer: page.url } };
  throw new Error('Nessun contenuto trovato in questa pagina');
}

/**
 * Lettori "una pagina per URL" (menu Pagina 01/02…, frecce avanti/indietro):
 * visita le pagine dello stesso capitolo in ampiezza, scoprendo i link a ogni passo,
 * e raccoglie l'immagine principale di ciascuna. I link ad altri capitoli vengono esclusi.
 */
async function crawlReader(book, page, $, first, aiNext = '') {
  const imgRe = (() => { try { return first.pattern ? new RegExp(first.pattern, 'i') : null; } catch { return null; } })();
  const mainImage = (p) => {
    const r = findImages(load(p.html), p.html, p.url, imgRe ? { imagePattern: first.pattern } : {});
    return r.images[0] || null;
  };
  const otherChapters = new Set(Chapters.list(book.id).map((c) => c.url));
  otherChapters.delete(page.url);
  let chapRe = null; try { chapRe = book.rules?.chapterPattern ? new RegExp(book.rules.chapterPattern, 'i') : null; } catch { /* ignore */ }
  const isOtherChapter = (u) => otherChapters.has(u) || (chapRe && chapRe.test(u) && u !== page.url);

  const byPage = new Map([[page.url, { n: 0, img: first.images[0] }]]);
  const queue = [];
  const enqueue = ($$, url) => {
    for (const p of findReaderPages($$, url)) {
      if (byPage.has(p.url) || queue.includes(p.url) || isOtherChapter(p.url)) continue;
      queue.push(p.url);
    }
    const nx = findNextLink($$, url);
    if (nx && !byPage.has(nx) && !queue.includes(nx) && !isOtherChapter(nx) && signature(nx) === signature(page.url)) queue.push(nx);
  };
  if (aiNext) queue.push(aiNext);
  enqueue($, page.url);

  const seenImgs = new Set([first.images[0]]);
  let order = 1;
  while (queue.length && byPage.size < MAX_READER_PAGES) {
    const batch = queue.splice(0, 4);
    for (const u of batch) byPage.set(u, null); // visitate: non rimetterle in coda
    const results = await Promise.all(batch.map((u) => fetchPage(u, { referer: page.url }).catch(() => null)));
    results.forEach((r, i) => {
      const url = batch[i];
      if (!r?.html) return;
      const img = mainImage(r);
      const n = pageNumber(page.url, url) ?? order;
      order++;
      if (img && !seenImgs.has(img)) { seenImgs.add(img); byPage.set(url, { n, img }); }
      enqueue(load(r.html), r.url);
    });
    Books.update(book.id, { message: `Pagine del capitolo: ${[...byPage.values()].filter(Boolean).length}` });
  }
  return [...byPage.values()].filter(Boolean).sort((a, b) => a.n - b.n).map((p) => p.img);
}

/**
 * Dato l'URL di una pagina con nome numerico (…/009/01.jpg), trova le altre pagine
 * provando i numeri vicini (con lo stesso numero di cifre) finché non esistono più.
 */
async function probeSequence(book, url, referer) {
  const m = url.match(/^(.*\/(?:p(?:age|ag|g)?[_-]?)?)(\d+)([a-z]?\.\w+)(\?.*)?$/i);
  if (!m) return [url];
  const [, prefix, num, ext, query = ''] = m;
  const make = (n) => `${prefix}${String(n).padStart(num.length, '0')}${ext}${query}`;
  const start = parseInt(num, 10);
  const found = new Map([[start, url]]);
  // indietro (se la pagina trovata non è la prima)
  for (let n = start - 1; n >= 0; n--) {
    if (!(await probeUrl(make(n), referer))) break;
    found.set(n, make(n));
  }
  // avanti, a gruppi di 4; ci fermiamo dopo 2 numeri mancanti consecutivi
  let n = start + 1; let misses = 0;
  while (misses < 2 && n < start + MAX_READER_PAGES) {
    const batch = [n, n + 1, n + 2, n + 3];
    const ok = await Promise.all(batch.map((k) => probeUrl(make(k), referer)));
    for (let i = 0; i < batch.length; i++) {
      if (ok[i]) { found.set(batch[i], make(batch[i])); misses = 0; } else if (++misses >= 2) break;
    }
    n += 4;
    Books.update(book.id, { message: `Pagine trovate: ${found.size}` });
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u);
}

/** Numero di pagina: il numero che cambia tra l'URL del capitolo e quello della pagina. */
function pageNumber(base, url) {
  const nb = base.match(/\d+/g) || []; const nu = url.match(/\d+/g) || [];
  if (nu.length === nb.length) {
    for (let i = 0; i < nu.length; i++) if (nu[i] !== nb[i]) return parseInt(nu[i], 10);
    return 0;
  }
  if (nu.length === nb.length + 1) return parseInt(nu[nu.length - 1], 10);
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function fillCover(bookId) {
  const book = Books.get(bookId);
  if (book.cover) return;
  const ready = Chapters.ready(bookId).find((c) => c.type === 'images' && c.content?.images?.length);
  if (ready) Books.update(bookId, { cover: ready.content.images[0] });
}

// ---------------------------------------------------------------------------
// 4. Download completo per lettura offline
// ---------------------------------------------------------------------------
export function downloadBook(bookId) {
  return exclusive(bookId, async () => {
    const book = Books.get(bookId);
    Books.update(bookId, { status: 'downloading' });
    try {
      const pending = Chapters.pending(bookId);
      let n = 0;
      await mapLimit(pending, 2, async (c) => {
        await resolveChapter(c.id, false).catch(() => {});
        Books.update(bookId, { message: `Analisi capitoli: ${++n}/${pending.length}` });
      });
      const urls = [];
      for (const c of Chapters.ready(bookId)) {
        const ref = c.content?.referer || c.url;
        if (c.type === 'images') for (const u of c.content.images) urls.push([u, ref]);
        else if (c.content?.url) urls.push([c.content.url, ref]);
      }
      const todo = urls.filter(([u]) => !isCached(u));
      let d = 0; let failed = 0;
      await mapLimit(todo, 6, async ([u, ref]) => {
        await getMedia(u, ref).catch(() => failed++);
        if (++d % 5 === 0 || d === todo.length) Books.update(bookId, { message: `Download: ${d}/${todo.length}` });
      });
      await fillCover(bookId);
      Books.update(bookId, { status: 'idle', message: `Disponibile offline: ${urls.length - failed} file${failed ? ` (${failed} errori)` : ''}` });
    } catch (e) {
      Books.update(bookId, { status: 'error', message: e.message });
    }
    return Books.get(book.id);
  });
}
