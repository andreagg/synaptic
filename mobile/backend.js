// Backend "locale" per la app Android: lo stesso motore del server gira nel telefono.
// Implementa le stesse rotte di server.js, senza rete verso un nostro server.
import { App } from '@capacitor/app';
import * as pdfjs from 'pdfjs-dist';
import { initStore, Books, Chapters } from './store.js';
import { initMedia, getMedia, mediaObjectUrl } from './fetcher.js';
import { addSource, scanBook, resolveChapterNow, downloadBook, isBusy } from '../src/engine/engine.js';
import { aiAvailable } from '../src/engine/ai.js';
import { idbGet, idbSet } from './idb.js';

pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

const fail = (status, message, data = {}) => { throw Object.assign(new Error(message), { status, data: { error: message, ...data } }); };
const bg = (p) => { p.catch((e) => console.warn(e)); };

export async function init() {
  const s = (await idbGet('kv', 'settings').catch(() => null)) || {};
  globalThis.SYNAPTIC_CONFIG = s;
  await initStore();
  await initMedia();
  for (const b of Books.list()) if (['scanning', 'downloading'].includes(b.status)) Books.update(b.id, { status: 'idle' });
  // aggiorna l'interfaccia quando il motore modifica i dati
  let t; window.addEventListener('synaptic:store', () => { clearTimeout(t); t = setTimeout(() => window.dispatchEvent(new Event('synaptic:changed')), 400); });
  // controllo aggiornamenti: all'avvio, quando l'app torna in primo piano e ogni 15 minuti mentre è aperta
  const check = () => { for (const b of Books.due()) if (!isBusy(b.id)) bg(scanBook(b.id)); };
  setTimeout(check, 3000);
  setInterval(check, 15 * 60 * 1000);
  App.addListener('resume', check).catch(() => {});
  // tasto "indietro" di Android: torna alla schermata precedente, esce dalla libreria
  App.addListener('backButton', () => {
    if (location.hash && location.hash !== '#/') history.back(); else App.exitApp();
  }).catch(() => {});
}

export const settings = {
  async get() { return { ...(globalThis.SYNAPTIC_CONFIG || {}) }; },
  async set(patch) {
    const s = { ...(globalThis.SYNAPTIC_CONFIG || {}), ...patch };
    globalThis.SYNAPTIC_CONFIG = s;
    await idbSet('kv', 'settings', s);
  },
};

export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body || {};
  const [p, query = ''] = path.split('?');
  const q = new URLSearchParams(query);
  let m;
  if (p === '/status') return { ai: aiAvailable() };
  if (p === '/books' && method === 'GET') return Books.list().map((b) => ({ ...b, busy: isBusy(b.id) }));
  if (p === '/books' && method === 'POST') {
    try { new URL(body.url); } catch { fail(400, 'URL non valido'); }
    return addSource({ ...body, update_hours: Number(body.update_hours ?? 24) });
  }
  if ((m = p.match(/^\/books\/(\d+)(?:\/(\w+))?$/))) {
    const b = Books.get(m[1]);
    if (!b) fail(404, 'Libro non trovato');
    const action = m[2];
    if (!action && method === 'GET') return { ...b, busy: isBusy(b.id), chapters: Chapters.list(b.id) };
    if (!action && method === 'PATCH') {
      const { title, update_hours, use_ai, render_js, rules } = body;
      return Books.update(b.id, { title, update_hours, use_ai, render_js, rules });
    }
    if (!action && method === 'DELETE') { Books.remove(b.id); return null; }
    if (action === 'scan') { bg(scanBook(b.id)); return { ok: true }; }
    if (action === 'download') { bg(downloadBook(b.id)); return { ok: true }; }
    if (action === 'seen') { Chapters.clearNew(b.id); return { ok: true }; }
  }
  if ((m = p.match(/^\/chapters\/(\d+)$/))) {
    let ch = Chapters.get(m[1]);
    if (!ch) fail(404, 'Capitolo non trovato');
    if (ch.status !== 'ready' || q.get('refresh')) {
      try { ch = await resolveChapterNow(ch.id, { force: !!q.get('refresh') }); } catch (e) { fail(422, e.message, { chapter: Chapters.get(ch.id) }); }
    }
    if (!ch) fail(404, 'Capitolo riorganizzato, ricarica il libro');
    const book = Books.get(ch.book_id);
    return { ...ch, book: { id: book.id, title: book.title }, ...Chapters.neighbours(ch) };
  }
  if ((m = p.match(/^\/chapters\/(\d+)\/progress$/))) {
    Chapters.update(m[1], { progress: Number(body.progress) || 0, read_at: Date.now(), is_new: false });
    return { ok: true };
  }
  fail(404, 'Rotta sconosciuta: ' + path);
}

// se il download nativo fallisce, lasciamo provare direttamente la WebView
export const mediaUrl = (u, ref) => mediaObjectUrl(u, ref).catch(() => u);

/** Android WebView non mostra i PDF: li disegniamo con pdf.js, una pagina sotto l'altra. */
export async function renderPdf(container, url, ref) {
  const { blob } = await getMedia(url, ref);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  container.innerHTML = '';
  const width = Math.min(container.clientWidth || window.innerWidth, 900);
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = (width / base.width) * (window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = '100%'; canvas.style.display = 'block'; canvas.style.marginBottom = '6px';
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}
