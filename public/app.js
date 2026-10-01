// Frontend a pagina singola, senza framework. Rotte: #/  #/book/:id  #/read/:chapterId
import * as backend from './backend.js';

const $view = document.getElementById('view');
const api = backend.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Le immagini vengono risolte in modo asincrono (proxy del server o cache locale dell'app).
const mediaAttr = (u, ref) => `data-m="${esc(u)}" data-ref="${esc(ref || '')}"`;
function hydrate(root = $view) {
  root.querySelectorAll('[data-m]').forEach(async (el) => {
    const u = el.dataset.m; el.removeAttribute('data-m');
    try {
      const src = await backend.mediaUrl(u, el.dataset.ref || undefined);
      if (el.tagName === 'IMG') el.src = src; else el.style.backgroundImage = `url('${src}')`;
    } catch { if (el.tagName === 'IMG') el.alt = '⚠️ immagine non disponibile'; }
  });
}
const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };
const KIND = { manga: '📖 Fumetto', series: '📚 Serie', pdf: '📄 PDF', article: '📰 Testo', mixed: '🗂️ Misto', unknown: '…' };
const ICON = { images: '🖼️', pdf: '📄', file: '📦', html: '📰', page: '•' };

let timer = null;
const poll = (fn, ms = 2000) => { clearInterval(timer); timer = setInterval(fn, ms); };

// Ridisegna la vista solo se è cambiata, mantenendo la posizione di scorrimento.
let lastHtml = '';
function setView(html) {
  if (html === lastHtml) return false;
  const y = scrollY;
  const q = document.activeElement?.id === 'q' ? document.activeElement : null;
  const caret = q?.selectionStart;
  $view.innerHTML = html;
  lastHtml = html;
  hydrate();
  scrollTo(0, y);
  if (q) { const n = document.getElementById('q'); n?.focus(); n?.setSelectionRange(caret, caret); }
  return true;
}
// Aggiorna la schermata corrente senza perdere lo scroll (dati cambiati, polling, ricerca).
let refreshing = false;
async function refresh() {
  const h = location.hash || '#/';
  if (refreshing || /^#\/(read|settings)/.test(h) || document.querySelector('dialog[open]')) return;
  refreshing = true;
  try {
    const m = h.match(/^#\/book\/(\d+)/);
    if (m) await renderBook(m[1]); else if (h === '#/' || h === '#' || h === '') await renderLibrary();
  } catch { /* riprova al prossimo aggiornamento */ } finally { refreshing = false; }
}

// ---------------------------------------------------------------- libreria
async function renderLibrary() {
  document.body.classList.remove('reading');
  const books = await api('/books');
  if (!books.length) {
    setView(`<div class="empty"><div class="big">📚</div><h2>La tua libreria è vuota</h2>
      <p>Aggiungi l'indirizzo di un sito con fumetti, capitoli, PDF o articoli:<br>verrà trasformato in un libro da leggere qui.</p>
      <button class="btn primary" onclick="document.getElementById('addBtn').click()">+ Aggiungi la prima fonte</button></div>`);
    return;
  }
  setView(`<div class="grid">${books.map((b) => `
    <a class="card" href="#/book/${b.id}">
      ${b.new_count ? `<span class="badge">+${b.new_count}</span>` : ''}
      <div class="cover" ${b.cover ? mediaAttr(b.cover, b.source_url) : ''}>${b.cover ? '' : '📘'}</div>
      <div class="info"><h3>${esc(b.title)}</h3>
        <div class="meta">${statusPill(b)} ${b.chapter_count} elem. · letti ${b.read_count}</div></div>
    </a>`).join('')}</div>`);
  if (books.some((b) => b.busy || ['scanning', 'downloading'].includes(b.status))) poll(refresh, 2500); else clearInterval(timer);
}
function statusPill(b) {
  if (b.busy || b.status === 'scanning') return '<span class="pill busy">analisi…</span>';
  if (b.status === 'downloading') return '<span class="pill busy">download…</span>';
  if (b.status === 'error') return '<span class="pill error">errore</span>';
  return `<span class="pill">${KIND[b.kind] || ''}</span>`;
}

// ---------------------------------------------------------------- libro
let filter = '';
let sortDesc = false;
let selecting = false;
const selected = new Set();
let bookCache = null;

function chapterRow(c, queued) {
  const m = c.meta || {};
  const state = queued.has(c.id) ? '<span class="pill busy">⏳ in coda</span>'
    : m.offline ? `<span class="pill ok">📥 ${m.pages ? m.pages + ' p.' : 'offline'}</span>`
    : m.pages ? `<span class="pill">${m.pages} p.</span>` : '';
  const check = selecting ? `<span class="check-box ${selected.has(c.id) ? 'on' : ''}">${selected.has(c.id) ? '✓' : ''}</span>` : '';
  return `<li class="${c.read_at ? 'read' : ''}"><a href="#/read/${c.id}" data-id="${c.id}">
      ${check}<span class="ico">${c.status === 'error' ? '⚠️' : ICON[c.type] || '•'}</span>
      <span class="t">${esc(c.title)}</span>
      ${c.is_new ? '<span class="dot" title="Nuovo"></span>' : ''}
      ${state}${c.read_at ? '<span class="pill ok">✓</span>' : ''}
    </a></li>`;
}

async function renderBook(id) {
  document.body.classList.remove('reading');
  const b = await api(`/books/${id}`);
  bookCache = b;
  const busy = b.busy || ['scanning', 'downloading'].includes(b.status);
  const queued = new Set(b.queued || []);
  let chs = b.chapters;
  if (filter) chs = chs.filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()));
  if (sortDesc) chs = [...chs].reverse();
  const lastRead = [...b.chapters].filter((c) => c.read_at).sort((x, y) => y.read_at - x.read_at)[0];
  const cont = lastRead || b.chapters[0];
  const offlineCount = b.chapters.filter((c) => c.meta?.offline).length;
  const html = `
    <section class="hero">
      <div class="cover" ${b.cover ? mediaAttr(b.cover, b.source_url) : ''}>${b.cover ? '' : '📘'}</div>
      <div>
        <h1>${esc(b.title)}</h1>
        <div class="src"><a href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source_url)}</a></div>
        <p class="muted desc">${esc(b.description || '')}</p>
        <div class="row">
          ${cont ? `<a class="btn primary" href="#/read/${cont.id}">${lastRead ? '▶ Continua' : '▶ Inizia a leggere'}</a>` : ''}
          <button class="btn" data-act="scan" ${busy ? 'disabled' : ''}>⟳ Cerca aggiornamenti</button>
          <button class="btn" data-act="select">${selecting ? '✕ Annulla selezione' : '⬇ Scegli capitoli da scaricare'}</button>
        </div>
        <div class="status">${busy || queued.size ? '<span class="spinner"></span>' : ''}<span>${esc(b.message || '')}</span></div>
        <div class="row muted" style="font-size:13px">
          <span>${KIND[b.kind] || ''}${offlineCount ? ` · 📥 ${offlineCount} offline` : ''}</span> ·
          <label>Aggiorna <select data-act="every" style="width:auto;padding:4px 8px">
            ${[[0, 'mai'], [1, 'ogni ora'], [6, 'ogni 6 ore'], [24, 'ogni giorno'], [168, 'ogni settimana']]
              .map(([v, l]) => `<option value="${v}" ${Number(b.update_hours) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
          <label class="check" style="display:inline-flex"><input type="checkbox" data-act="ai" ${b.use_ai ? 'checked' : ''}> AI</label>
          <label class="check" style="display:inline-flex"><input type="checkbox" data-act="js" ${b.render_js ? 'checked' : ''}> JS</label>
          <button class="btn danger" data-act="del" style="padding:4px 10px">Elimina</button>
        </div>
      </div>
    </section>
    ${!b.chapters.length && !busy ? `<div class="empty" style="padding:24px"><p>Nessun capitolo ancora.</p><button class="btn primary" data-act="scan">⟳ Cerca i capitoli</button></div>` : ''}
    <div class="toolbar">
      <strong>${b.chapters.length} capitoli${b.chapters.some((c) => c.is_new) ? ` · <span style="color:var(--accent)">${b.chapters.filter((c) => c.is_new).length} nuovi</span>` : ''}</strong>
      <div class="row"><input id="q" placeholder="Cerca…" value="${esc(filter)}"><button class="btn" data-act="sort">${sortDesc ? '↑' : '↓'}</button></div>
    </div>
    ${selecting ? `<div class="row sel-tools">
      <button class="btn" data-act="sel-next">Prossimi 10 da leggere</button>
      <button class="btn" data-act="sel-all">Tutti${filter ? ' (filtrati)' : ''}</button>
      <button class="btn" data-act="sel-none">Nessuno</button></div>` : ''}
    <ul class="chapters ${selecting ? 'selecting' : ''}">${chs.map((c) => chapterRow(c, queued)).join('')}</ul>
    ${selecting ? `<div class="selbar"><span>${selected.size} selezionati</span>
      <button class="btn primary" data-act="sel-go" ${selected.size ? '' : 'disabled'}>⬇ Scarica offline</button></div>` : ''}`;
  setView(html);
  if (busy || queued.size) poll(refresh, 2000); else clearInterval(timer);
}

// azioni della scheda libro (delegate: sopravvivono ai ridisegni)
$view.addEventListener('click', async (e) => {
  const b = bookCache;
  if (!b || !location.hash.startsWith('#/book/')) return;
  const link = e.target.closest('.chapters a[data-id]');
  if (link && selecting) {
    e.preventDefault();
    const cid = Number(link.dataset.id);
    selected.has(cid) ? selected.delete(cid) : selected.add(cid);
    return refresh();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || e.target.closest('select, input')) return;
  const visible = () => b.chapters.filter((c) => !filter || c.title.toLowerCase().includes(filter.toLowerCase()));
  if (act === 'scan') { await api(`/books/${b.id}/scan`, { method: 'POST' }); toast('Controllo aggiornamenti avviato'); setTimeout(refresh, 300); }
  if (act === 'select') { selecting = !selecting; selected.clear(); refresh(); }
  if (act === 'sort') { sortDesc = !sortDesc; refresh(); }
  if (act === 'sel-all') { visible().forEach((c) => selected.add(c.id)); refresh(); }
  if (act === 'sel-none') { selected.clear(); refresh(); }
  if (act === 'sel-next') {
    const lastRead = [...b.chapters].filter((c) => c.read_at).sort((x, y) => y.read_at - x.read_at)[0];
    const start = lastRead ? b.chapters.findIndex((c) => c.id === lastRead.id) : 0;
    b.chapters.slice(start, start + 10).forEach((c) => selected.add(c.id));
    refresh();
  }
  if (act === 'sel-go') {
    const ids = b.chapters.filter((c) => selected.has(c.id)).map((c) => c.id);
    await api(`/books/${b.id}/download`, { method: 'POST', body: { chapters: ids } });
    toast(`${ids.length} capitoli in download`);
    selecting = false; selected.clear(); setTimeout(refresh, 300);
  }
  if (act === 'del' && confirm('Eliminare questo libro dalla libreria?')) { await api(`/books/${b.id}`, { method: 'DELETE' }); location.hash = '#/'; }
});
$view.addEventListener('change', (e) => {
  const b = bookCache; const act = e.target.dataset?.act;
  if (!b || !act) return;
  if (act === 'every') api(`/books/${b.id}`, { method: 'PATCH', body: { update_hours: Number(e.target.value) } }).then(() => toast('Salvato'));
  if (act === 'ai') api(`/books/${b.id}`, { method: 'PATCH', body: { use_ai: e.target.checked } });
  if (act === 'js') api(`/books/${b.id}`, { method: 'PATCH', body: { render_js: e.target.checked } });
});
$view.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  filter = e.target.value;
  refresh(true);
});

// ---------------------------------------------------------------- lettore
async function renderReader(id) {
  clearInterval(timer);
  document.body.classList.add('reading');
  $view.innerHTML = '<div class="empty"><div class="spinner" style="margin:auto;width:32px;height:32px"></div><p>Preparo il capitolo…</p></div>';
  let ch;
  try { ch = await api(`/chapters/${id}`); } catch (e) {
    $view.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p>
      <div class="row" style="justify-content:center">
      ${e.data?.chapter ? `<a class="btn" href="#/book/${e.data.chapter.book_id}">← Torna al libro</a>
      <a class="btn" href="${esc(e.data.chapter.url)}" target="_blank">Apri sul sito</a>` : '<a class="btn" href="#/">← Libreria</a>'}</div></div>`;
    return;
  }
  const bar = `<div class="reader-bar" id="rbar">
      <a class="btn" href="#/book/${ch.book.id}">←</a>
      <div class="title"><div class="muted" style="font-size:11px">${esc(ch.book.title)}</div><span id="rtitle">${esc(ch.title)}</span></div>
      <a class="btn" id="rprev" href="${ch.prev ? `#/read/${ch.prev.id}` : '#'}" title="Precedente" ${ch.prev ? '' : 'hidden'}>‹</a>
      <a class="btn" id="rnext" href="${ch.next ? `#/read/${ch.next.id}` : '#'}" title="Successivo" ${ch.next ? '' : 'hidden'}>›</a>
    </div><div class="progress" id="prog"></div>`;
  const nav = `<div class="reader-nav">
      ${ch.prev ? `<a class="btn" href="#/read/${ch.prev.id}">‹ ${esc(ch.prev.title)}</a>` : ''}
      ${ch.next ? `<a class="btn primary" href="#/read/${ch.next.id}">${esc(ch.next.title)} ›</a>` : `<a class="btn" href="#/book/${ch.book.id}">Fine · torna al libro</a>`}
    </div>`;
  const ref = ch.content?.referer || ch.url;
  if (ch.type === 'images') {
    $view.innerHTML = bar + '<div class="pages" id="pages"></div><div class="reader-nav" id="tail"></div>';
    continuousReader(ch);
    return;
  } else if (ch.type === 'pdf') {
    if (backend.renderPdf) {
      $view.innerHTML = bar + '<div class="pages" id="pdfpages"><p class="muted" style="text-align:center">Apro il PDF…</p></div>' + nav;
      backend.renderPdf(document.getElementById('pdfpages'), ch.content.url, ref).catch((e) => {
        document.getElementById('pdfpages').innerHTML = `<p class="empty">⚠️ ${esc(e.message)}</p>`;
      });
    } else {
      $view.innerHTML = bar + `<iframe class="pdf" src="${await backend.mediaUrl(ch.content.url, ref)}"></iframe>`;
    }
  } else if (ch.type === 'html') {
    $view.innerHTML = bar + `<article class="article">${ch.content.html}</article>` + nav;
    $view.querySelectorAll('.article img').forEach((img) => {
      try { img.dataset.m = new URL(img.getAttribute('src'), ch.url).href; img.dataset.ref = ch.url; img.removeAttribute('src'); } catch { /* ignore */ }
    });
  } else {
    $view.innerHTML = bar + `<div class="empty"><div class="big">📦</div><p>File scaricabile</p>
      <a class="btn primary" href="${await backend.mediaUrl(ch.content.url, ref)}" download>Scarica</a></div>`;
  }
  hydrate();
  // barra che si nasconde leggendo, avanzamento e salvataggio progresso
  let lastY = 0; let saved = 0;
  const rbar = document.getElementById('rbar'); const prog = document.getElementById('prog');
  const key = `pos:${id}`;
  try { const y = Number(localStorage.getItem(key)); if (y > 0 && ch.type !== 'pdf') setTimeout(() => scrollTo(0, y), 50); } catch { /* storage non disponibile */ }
  api(`/chapters/${id}/progress`, { method: 'POST', body: { progress: 0 } }).catch(() => {});
  window.onscroll = () => {
    const y = scrollY; const max = document.documentElement.scrollHeight - innerHeight;
    rbar?.classList.toggle('hide', y > lastY && y > 80); lastY = y;
    const p = max > 0 ? Math.min(1, y / max) : 1;
    if (prog) prog.style.width = (p * 100) + '%';
    try { localStorage.setItem(key, String(y)); } catch { /* ignore */ }
    if (Date.now() - saved > 4000) { saved = Date.now(); api(`/chapters/${id}/progress`, { method: 'POST', body: { progress: p } }).catch(() => {}); }
  };
  $view.onclick = (e) => { if (e.target.tagName === 'IMG') rbar?.classList.toggle('hide'); };
  document.onkeydown = (e) => {
    if (!document.body.classList.contains('reading')) return;
    if (e.key === 'ArrowRight' && ch.next) location.hash = `#/read/${ch.next.id}`;
    if (e.key === 'ArrowLeft' && ch.prev) location.hash = `#/read/${ch.prev.id}`;
  };
  // pre-carica il capitolo successivo sul server
  if (ch.next) setTimeout(() => api(`/chapters/${ch.next.id}?prefetch=1`).catch(() => {}), 1500);
}

/**
 * Lettura continua dei fumetti: i capitoli si susseguono uno sotto l'altro.
 * Arrivati in fondo si carica il successivo; titolo, indirizzo e progresso seguono lo scorrimento.
 */
function continuousReader(first) {
  const pagesEl = document.getElementById('pages');
  const tail = document.getElementById('tail');
  const rbar = document.getElementById('rbar'); const prog = document.getElementById('prog');
  const titleEl = document.getElementById('rtitle');
  const pgEl = document.createElement('span');
  pgEl.className = 'pgnum'; pgEl.textContent = `1/${first.content.images.length}`;
  document.getElementById('rprev').before(pgEl);
  const loaded = [];
  let last = first; let current = first; let loading = false;

  // le immagini si scaricano solo quando si avvicinano allo schermo
  const lazy = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { lazy.unobserve(e.target); hydrate(e.target.parentNode); }
  }), { rootMargin: '2500px 0px' });

  const append = (c) => {
    const sec = document.createElement('section');
    sec.className = 'chap'; sec.dataset.id = c.id;
    const ref = c.content.referer || c.url;
    sec.innerHTML = `<div class="chap-head">${esc(c.title)}</div>` + c.content.images.map((u, i) =>
      `<div class="pg"><img ${mediaAttr(u, ref)} alt="Pagina ${i + 1}" onload="this.classList.add('loaded')"></div>`).join('');
    pagesEl.appendChild(sec);
    sec.querySelectorAll('img[data-m]').forEach((img) => lazy.observe(img));
    loaded.push({ ch: c, el: sec, imgs: [...sec.querySelectorAll('.pg')] });
    // download "live": il capitolo successivo si scarica in background mentre leggi
    if (c.next) api(`/books/${first.book.id}/download`, { method: 'POST', body: { chapters: [c.next.id], prefetch: true } }).catch(() => {});
  };

  const loadNext = async () => {
    if (loading) return;
    if (!last.next) { tail.innerHTML = `<a class="btn" href="#/book/${first.book.id}">Fine · torna al libro</a>`; return; }
    loading = true;
    tail.innerHTML = `<span class="spinner"></span>&nbsp;<span class="muted">Carico ${esc(last.next.title)}…</span>`;
    try {
      const c = await api(`/chapters/${last.next.id}`);
      if (c.type === 'images' && c.content?.images?.length) {
        append(c); last = c; tail.innerHTML = '';
      } else {
        tail.innerHTML = `<a class="btn primary" href="#/read/${c.id}">${esc(c.title)} ›</a>`;
        last = { next: null, noMore: true };
      }
    } catch (e) {
      tail.innerHTML = `<p class="muted">⚠️ ${esc(e.message)}</p><button class="btn" id="retry">Riprova</button>`;
      document.getElementById('retry').onclick = () => loadNext();
      loading = false;
      return;
    }
    loading = false;
    if (!last.noMore) { tailObs.unobserve(tail); tailObs.observe(tail); } // ricontrolla se serve un altro capitolo
  };
  const tailObs = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadNext(); }, { rootMargin: '3000px 0px' });

  append(first);
  tailObs.observe(tail);
  // riprende dal punto in cui si era rimasti nel capitolo
  try {
    const off = Number(localStorage.getItem(`pos:${first.id}`));
    if (off > 0) setTimeout(() => scrollTo(0, loaded[0].el.offsetTop + off), 400);
  } catch { /* storage non disponibile */ }
  api(`/chapters/${first.id}/progress`, { method: 'POST', body: { progress: 0 } }).catch(() => {});

  let lastY = 0; let saved = 0;
  window.onscroll = () => {
    const y = scrollY;
    rbar?.classList.toggle('hide', y > lastY && y > 80); lastY = y;
    const probe = innerHeight * 0.3;
    let cur = loaded[0];
    for (const l of loaded) if (l.el.getBoundingClientRect().top <= probe) cur = l;
    const r = cur.el.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (probe - r.top) / Math.max(1, r.height - innerHeight * 0.7)));
    if (prog) prog.style.width = (p * 100) + '%';
    let pg = 0;
    for (let i = 0; i < cur.imgs.length; i++) if (cur.imgs[i].getBoundingClientRect().top <= probe) pg = i + 1;
    pgEl.textContent = `${Math.max(1, pg)}/${cur.imgs.length}`;
    if (cur.ch.id !== current.id) {
      api(`/chapters/${current.id}/progress`, { method: 'POST', body: { progress: 1 } }).catch(() => {});
      current = cur.ch;
      titleEl.textContent = current.title;
      history.replaceState(null, '', `#/read/${current.id}`);
      const prev = document.getElementById('rprev'); const next = document.getElementById('rnext');
      prev.hidden = !current.prev; if (current.prev) prev.href = `#/read/${current.prev.id}`;
      next.hidden = !current.next; if (current.next) next.href = `#/read/${current.next.id}`;
      saved = 0;
    }
    try { localStorage.setItem(`pos:${current.id}`, String(Math.max(0, -r.top))); } catch { /* ignore */ }
    if (Date.now() - saved > 4000) { saved = Date.now(); api(`/chapters/${current.id}/progress`, { method: 'POST', body: { progress: p } }).catch(() => {}); }
  };
  $view.onclick = (e) => { if (e.target.tagName === 'IMG') rbar?.classList.toggle('hide'); };
  document.onkeydown = (e) => {
    if (!document.body.classList.contains('reading')) return;
    if (e.key === 'ArrowRight' && current.next) location.hash = `#/read/${current.next.id}`;
    if (e.key === 'ArrowLeft' && current.prev) location.hash = `#/read/${current.prev.id}`;
  };
}

// ---------------------------------------------------------------- router
async function route() {
  window.onscroll = null; $view.onclick = null; lastHtml = '';
  if (!location.hash.startsWith('#/book/')) { selecting = false; selected.clear(); }
  const h = location.hash || '#/';
  let m;
  try {
    if ((m = h.match(/^#\/book\/(\d+)/))) { await renderBook(m[1]); await api(`/books/${m[1]}/seen`, { method: 'POST' }).catch(() => {}); }
    else if ((m = h.match(/^#\/read\/(\d+)/))) await renderReader(m[1]);
    else if (h.startsWith('#/settings') && backend.settings) await renderSettings();
    else { clearInterval(timer); await renderLibrary(); }
    if (!h.startsWith('#/read')) scrollTo(0, 0);
  } catch (e) { $view.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p></div>`; }
}
// ---------------------------------------------------------------- aggiunta fonte
const dlg = document.getElementById('addDialog');
document.getElementById('addBtn').onclick = () => dlg.showModal();
document.getElementById('addForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = new FormData(e.target);
  try {
    const b = await api('/books', { method: 'POST', body: {
      url: f.get('url'), title: f.get('title') || undefined, update_hours: Number(f.get('update_hours')),
      use_ai: f.get('use_ai') === 'on', render_js: f.get('render_js') === 'on',
    } });
    e.target.reset();
    toast('Fonte aggiunta: analisi in corso…');
    location.hash = `#/book/${b.id}`;
  } catch (err) { toast(err.message); }
});

addEventListener('hashchange', route);
await backend.init();
window.addEventListener('synaptic:changed', () => refresh());
route();

// impostazioni (solo app mobile: chiave AI e registro diagnostico)
if (backend.settings) {
  const btn = document.createElement('a');
  btn.className = 'btn'; btn.textContent = '⚙'; btn.title = 'Impostazioni'; btn.href = '#/settings';
  document.getElementById('addBtn').before(btn);
}
async function renderSettings() {
  clearInterval(timer);
  document.body.classList.remove('reading');
  const cur = await backend.settings.get();
  $view.innerHTML = `<h2>Impostazioni</h2><p class="muted">Versione ${esc(backend.version || '')}</p>
    <label class="muted">Chiave API Anthropic (attiva l'AI per i siti difficili)
      <input id="key" type="password" value="${esc(cur.ANTHROPIC_API_KEY || '')}" placeholder="sk-ant-…" style="margin-top:6px"></label>
    <div class="row" style="margin:10px 0 24px"><button class="btn primary" id="save">Salva</button></div>
    <div class="toolbar"><strong>Registro diagnostico</strong>
      <div class="row"><button class="btn" id="copy">Copia</button><button class="btn" id="refresh">Aggiorna</button></div></div>
    <pre id="log" style="white-space:pre-wrap;word-break:break-all;background:var(--panel);padding:12px;border-radius:12px;font-size:11px;max-height:60vh;overflow:auto"></pre>`;
  const show = () => { const el = document.getElementById('log'); el.textContent = backend.logs?.() || '(vuoto)'; el.scrollTop = el.scrollHeight; };
  show();
  document.getElementById('refresh').onclick = show;
  document.getElementById('copy').onclick = () => navigator.clipboard.writeText(backend.logs?.() || '').then(() => toast('Registro copiato'), () => toast('Copia non riuscita'));
  document.getElementById('save').onclick = async () => {
    const key = document.getElementById('key').value.trim();
    await backend.settings.set({ ANTHROPIC_API_KEY: key });
    toast(key ? 'AI attivata' : 'AI disattivata');
  };
}
