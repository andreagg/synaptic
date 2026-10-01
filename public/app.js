// Frontend a pagina singola, senza framework. Rotte: #/  #/book/:id  #/read/:chapterId
import * as backend from './backend.js';

const $view = document.getElementById('view');
const api = backend.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Le immagini vengono risolte in modo asincrono (proxy del server o cache locale dell'app).
const mediaAttr = (u, ref) => `data-m="${esc(u)}" data-ref="${esc(ref || '')}"`;
function hydrate(root = $view) {
  root.querySelectorAll('[data-m]').forEach(async (el) => {
    const u = el.dataset.m; const ref = el.dataset.ref || undefined;
    el.removeAttribute('data-m');
    try {
      const src = await backend.mediaUrl(u, ref);
      if (el.tagName === 'IMG') el.src = src; else el.style.backgroundImage = `url('${src}')`;
    } catch {
      // ripiego: immagine diretta senza Referer (molte protezioni hotlink lo accettano)
      if (el.tagName !== 'IMG') return;
      el.referrerPolicy = 'no-referrer';
      el.onerror = () => imageFailed(el, u, ref);
      el.src = u;
    }
  });
}
function imageFailed(el, u, ref) {
  const box = document.createElement('div');
  box.className = 'img-fail';
  box.innerHTML = `<span>⚠️ ${esc(el.alt || 'Immagine')} non caricata</span><button class="btn">Riprova</button>`;
  box.querySelector('button').onclick = async () => {
    box.querySelector('button').textContent = '…';
    try {
      const src = backend.mediaUrlForce ? await backend.mediaUrlForce(u, ref) : await backend.mediaUrl(u, ref);
      el.onerror = null; el.src = src; box.replaceWith(el);
    } catch (e) { box.querySelector('span').textContent = `⚠️ ${e.message}`; box.querySelector('button').textContent = 'Riprova'; }
  };
  el.replaceWith(box);
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
        <div class="status">${busy || queued.size ? '<span class="spinner"></span>' : ''}<span>${esc(b.message || '')}</span>
          ${queued.size ? `<button class="btn" data-act="cancel" style="padding:4px 10px">✕ Annulla (${queued.size})</button>` : ''}</div>
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
  if (act === 'cancel') { await api(`/books/${b.id}/download`, { method: 'POST', body: { cancel: true } }); toast('Download annullati'); setTimeout(refresh, 300); }
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
const chapterState = (c) => {
  if (!c) return '';
  if (c.meta?.offline) return `📥 Già scaricato${c.meta.pages ? ` · ${c.meta.pages} pagine` : ''}: si apre subito`;
  if (c.status === 'ready') return `🌐 Pagine già trovate${c.meta?.pages ? ` (${c.meta.pages})` : ''}: verranno scaricate ora`;
  return '⬇ Non ancora scaricato: verrà analizzato e scaricato ora (serve connessione)';
};

async function renderReader(id) {
  clearInterval(timer);
  document.body.classList.add('reading');
  // schermata di caricamento con quello che sta succedendo
  const peek = await api(`/chapters/${id}?peek=1`).catch(() => null);
  const ready = peek?.status === 'ready';
  $view.innerHTML = `<div class="loader-screen">
      <div class="spinner big"></div>
      <h3>${esc(peek?.title || 'Capitolo')}</h3>
      <p id="ldmsg" class="muted">${ready ? 'Apro il capitolo…' : 'Analizzo il capitolo e cerco le pagine…'}</p>
      ${ready ? '' : '<p class="muted small">Alla prima apertura il sito può chiedere una verifica: si apre il browser interno per qualche secondo.</p>'}
      ${peek ? `<a class="btn" href="#/book/${peek.book_id}">Annulla</a>` : ''}
    </div>`;
  let watching = true;
  if (peek && !ready) {
    (async () => {
      while (watching) {
        await new Promise((r) => setTimeout(r, 600));
        const b = await api(`/books/${peek.book_id}?lite=1`).catch(() => null);
        const el = document.getElementById('ldmsg');
        if (!watching || !el) break;
        if (b?.message) el.textContent = b.message;
      }
    })();
  }
  let ch;
  try { ch = await api(`/chapters/${id}`); } catch (e) {
    watching = false;
    $view.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p>
      <div class="row" style="justify-content:center">
      <button class="btn primary" onclick="location.reload()">Riprova</button>
      ${e.data?.chapter ? `<a class="btn" href="#/book/${e.data.chapter.book_id}">← Torna al libro</a>
      <a class="btn" href="${esc(e.data.chapter.url)}" target="_blank">Apri sul sito</a>` : '<a class="btn" href="#/">← Libreria</a>'}</div></div>`;
    return;
  }
  watching = false;
  if (location.hash !== `#/read/${id}`) return; // l'utente è andato altrove nel frattempo

  const bar = `<div class="reader-bar" id="rbar">
      <a class="btn" href="#/book/${ch.book.id}">←</a>
      <div class="title"><div class="muted" style="font-size:11px">${esc(ch.book.title)}</div><span id="rtitle">${esc(ch.title)}</span></div>
      <span class="pgnum" id="pgnum"></span>
      ${ch.type === 'images' ? '<button class="btn" id="zoombtn" title="Zoom">🔍</button>' : ''}
    </div><div class="progress" id="prog"></div><div class="loadpill" id="loadpill" hidden></div>`;
  const end = `<div class="chapter-end">
      <p class="muted">Fine di <b>${esc(ch.title)}</b></p>
      ${ch.next ? `<a class="btn primary big" href="#/read/${ch.next.id}">Capitolo successivo ›<br><small>${esc(ch.next.title)}</small></a>
        <p class="muted small">${chapterState(ch.next)}</p>` : `<a class="btn" href="#/book/${ch.book.id}">Fine · torna al libro</a>`}
      <div class="row" style="justify-content:center">
        ${ch.prev ? `<a class="btn" href="#/read/${ch.prev.id}">‹ Precedente</a>` : ''}
        <a class="btn" href="#/book/${ch.book.id}">Elenco capitoli</a>
      </div>
    </div>`;
  const ref = ch.content?.referer || ch.url;

  if (ch.type === 'images') {
    const imgs = ch.content.images;
    $view.innerHTML = bar + `<div class="pages" id="pages">${imgs.map((u, i) =>
      `<div class="pg" data-i="${i}"><img ${mediaAttr(u, ref)} alt="Pagina ${i + 1}" onload="this.parentNode.classList.add('ok')"></div>`).join('')}</div>` + end;
    // il capitolo aperto viene salvato offline (tutte le pagine)
    if (!ch.meta?.offline) api(`/books/${ch.book.id}/download`, { method: 'POST', body: { chapters: [ch.id] } }).catch(() => {});
    hydrate();
    trackLoading(imgs.length);
    setupImageReader(ch);
  } else if (ch.type === 'pdf') {
    if (backend.renderPdf) {
      $view.innerHTML = bar + '<div class="pages" id="pdfpages"><p class="muted" style="text-align:center">Apro il PDF…</p></div>' + end;
      backend.renderPdf(document.getElementById('pdfpages'), ch.content.url, ref).catch((e) => {
        document.getElementById('pdfpages').innerHTML = `<p class="empty">⚠️ ${esc(e.message)}</p>`;
      });
    } else {
      $view.innerHTML = bar + `<iframe class="pdf" src="${await backend.mediaUrl(ch.content.url, ref)}"></iframe>`;
    }
    setupScroll(ch);
  } else if (ch.type === 'html') {
    $view.innerHTML = bar + `<article class="article">${ch.content.html}</article>` + end;
    $view.querySelectorAll('.article img').forEach((img) => {
      try { img.dataset.m = new URL(img.getAttribute('src'), ch.url).href; img.dataset.ref = ch.url; img.removeAttribute('src'); } catch { /* ignore */ }
    });
    hydrate();
    setupScroll(ch);
  } else {
    $view.innerHTML = bar + `<div class="empty"><div class="big">📦</div><p>File scaricabile</p>
      <a class="btn primary" href="${await backend.mediaUrl(ch.content.url, ref)}" download>Scarica</a></div>` + end;
  }
}

/** Mostra "Pagine caricate 5/18" finché tutte le immagini non sono arrivate. */
function trackLoading(total) {
  const pill = document.getElementById('loadpill');
  const update = () => {
    if (!pill.isConnected) return;
    const ok = document.querySelectorAll('.pages .pg.ok').length;
    const failed = document.querySelectorAll('.pages .img-fail').length;
    if (ok + failed >= total) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.innerHTML = `<span class="spinner"></span> Pagine caricate ${ok}/${total}`;
    setTimeout(update, 400);
  };
  update();
}

function setupScroll(ch) {
  const rbar = document.getElementById('rbar'); const prog = document.getElementById('prog');
  const key = `pos:${ch.id}`;
  try { const y = Number(localStorage.getItem(key)); if (y > 0) setTimeout(() => scrollTo(0, y), 300); } catch { /* storage non disponibile */ }
  api(`/chapters/${ch.id}/progress`, { method: 'POST', body: { progress: 0 } }).catch(() => {});
  let lastY = 0; let saved = 0;
  const pgEl = document.getElementById('pgnum');
  const pages = [...document.querySelectorAll('.pages .pg')];
  window.onscroll = () => {
    const y = scrollY; const max = document.documentElement.scrollHeight - innerHeight;
    rbar?.classList.toggle('hide', y > lastY && y > 80); lastY = y;
    const p = max > 0 ? Math.min(1, y / max) : 1;
    if (prog) prog.style.width = (p * 100) + '%';
    if (pages.length && pgEl) {
      const probe = innerHeight * 0.3; let pg = 1;
      for (let i = 0; i < pages.length; i++) if (pages[i].getBoundingClientRect().top <= probe) pg = i + 1;
      pgEl.textContent = `${pg}/${pages.length}`;
    }
    try { localStorage.setItem(key, String(y)); } catch { /* ignore */ }
    if (Date.now() - saved > 4000) { saved = Date.now(); api(`/chapters/${ch.id}/progress`, { method: 'POST', body: { progress: p } }).catch(() => {}); }
  };
  window.onscroll();
  document.onkeydown = (e) => {
    if (!document.body.classList.contains('reading') || document.querySelector('.zoom')) return;
    if (e.key === 'ArrowRight' && ch.next) location.hash = `#/read/${ch.next.id}`;
    if (e.key === 'ArrowLeft' && ch.prev) location.hash = `#/read/${ch.prev.id}`;
  };
}

/** Lettore a immagini: scorrimento, tocco singolo = barra, doppio tocco o pizzico = zoom. */
function setupImageReader(ch) {
  setupScroll(ch);
  const rbar = document.getElementById('rbar');
  const pagesEl = document.getElementById('pages');
  const srcOf = () => [...pagesEl.querySelectorAll('.pg img')].map((i) => i.currentSrc || i.src);
  let lastTap = 0; let tapTimer = null;
  pagesEl.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pg = e.target.closest('.pg'); if (!pg) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer); lastTap = 0;
      openZoom(srcOf(), Number(pg.dataset.i), { scale: 2.5, x: e.clientX, y: e.clientY });
    } else {
      lastTap = now;
      tapTimer = setTimeout(() => rbar?.classList.toggle('hide'), 300);
    }
  });
  // pizzico con due dita sulla pagina: apre il visore
  const touches = new Map();
  pagesEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, e);
    if (touches.size === 2) {
      const pg = e.target.closest('.pg');
      touches.clear();
      if (pg) openZoom(srcOf(), Number(pg.dataset.i), { scale: 1.8, x: e.clientX, y: e.clientY });
    }
  });
  const clear = (e) => touches.delete(e.pointerId);
  pagesEl.addEventListener('pointerup', clear); pagesEl.addEventListener('pointercancel', clear);
  document.getElementById('zoombtn').onclick = () => {
    const probe = innerHeight * 0.3; let idx = 0;
    pagesEl.querySelectorAll('.pg').forEach((p, i) => { if (p.getBoundingClientRect().top <= probe) idx = i; });
    openZoom(srcOf(), idx, { scale: 1 });
  };
}

/**
 * Visore con zoom: pizzico per ingrandire, trascina per spostarti, doppio tocco per
 * ingrandire/ridurre, scorri a destra/sinistra (a zoom 1) per cambiare pagina.
 */
function openZoom(srcs, index, start = {}) {
  document.querySelector('.zoom')?.remove();
  const ov = document.createElement('div');
  ov.className = 'zoom';
  ov.innerHTML = `<div class="zoom-stage"><img alt=""></div>
    <div class="zoom-bar"><button class="btn" data-z="prev">‹</button><span class="zoom-n"></span>
    <button class="btn" data-z="next">›</button><button class="btn" data-z="fit">1:1</button><button class="btn" data-z="close">✕</button></div>`;
  document.body.appendChild(ov);
  const stage = ov.querySelector('.zoom-stage'); const img = ov.querySelector('img'); const num = ov.querySelector('.zoom-n');
  let s = 1; let x = 0; let y = 0; let base = { w: 0, h: 0 };
  const clampPos = () => {
    const W = stage.clientWidth; const H = stage.clientHeight;
    const w = base.w * s; const h = base.h * s;
    x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, x));
    y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, y));
  };
  const apply = (anim) => {
    clampPos();
    img.style.transition = anim ? 'transform .18s ease-out' : 'none';
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  const zoomAt = (ns, px, py, anim) => {
    ns = Math.max(1, Math.min(6, ns));
    const r = stage.getBoundingClientRect(); px -= r.left; py -= r.top;
    x = px - (px - x) * (ns / s); y = py - (py - y) * (ns / s); s = ns;
    apply(anim);
  };
  const show = (i, initial) => {
    index = Math.max(0, Math.min(srcs.length - 1, i));
    num.textContent = `${index + 1}/${srcs.length}`;
    img.onload = () => {
      const W = stage.clientWidth; const H = stage.clientHeight;
      const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      base = { w: img.naturalWidth * k, h: img.naturalHeight * k };
      img.style.width = base.w + 'px'; img.style.height = base.h + 'px';
      s = 1; x = 0; y = 0; apply(false);
      if (initial?.scale > 1) zoomAt(initial.scale, initial.x ?? W / 2, initial.y ?? H / 2, true);
    };
    img.src = srcs[index];
  };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') show(index + 1); if (e.key === 'ArrowLeft') show(index - 1); };
  document.addEventListener('keydown', onKey);
  ov.querySelector('.zoom-bar').onclick = (e) => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'close') close();
    if (z === 'prev') show(index - 1);
    if (z === 'next') show(index + 1);
    if (z === 'fit') { s = 1; apply(true); }
  };
  // gesti
  const pts = new Map(); let pinch = null; let pan = null; let lastTap = 0; let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s }; pan = null; swipe = null;
    } else if (pts.size === 1) {
      pan = { x: e.clientX, y: e.clientY, ox: x, oy: y }; swipe = { x: e.clientX, y: e.clientY, t: Date.now() };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch.s * (d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2, false);
    } else if (pan && s > 1) {
      x = pan.ox + (e.clientX - pan.x); y = pan.oy + (e.clientY - pan.y); apply(false);
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (swipe && s <= 1.01) {
        const dx = e.clientX - swipe.x; const dy = e.clientY - swipe.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
      }
      const moved = swipe && Math.hypot(e.clientX - swipe.x, e.clientY - swipe.y) > 10;
      if (!moved) {
        const now = Date.now();
        if (now - lastTap < 300) { zoomAt(s > 1.2 ? 1 : 2.5, e.clientX, e.clientY, true); lastTap = 0; } else lastTap = now;
      }
      pan = null; swipe = null;
    }
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY, false); }, { passive: false });
  show(index, start);
}

// ---------------------------------------------------------------- router
async function route() {
  window.onscroll = null; $view.onclick = null; lastHtml = ''; document.querySelector('.zoom')?.remove();
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
    ${backend.diagnose ? '<div class="row" style="margin:0 0 16px"><button class="btn" id="diag">🔍 Test download immagini</button></div>' : ''}
    <div class="toolbar"><strong>Registro diagnostico</strong>
      <div class="row"><button class="btn" id="copy">Copia</button><button class="btn" id="refresh">Aggiorna</button></div></div>
    <pre id="log" style="white-space:pre-wrap;word-break:break-all;background:var(--panel);padding:12px;border-radius:12px;font-size:11px;max-height:60vh;overflow:auto"></pre>`;
  const show = () => { const el = document.getElementById('log'); el.textContent = backend.logs?.() || '(vuoto)'; el.scrollTop = el.scrollHeight; };
  show();
  document.getElementById('refresh').onclick = show;
  const diag = document.getElementById('diag');
  if (diag) diag.onclick = async () => { diag.disabled = true; diag.textContent = 'Test in corso…'; await backend.diagnose().catch((e) => console.error(e)); diag.disabled = false; diag.textContent = '🔍 Test download immagini'; show(); };
  document.getElementById('copy').onclick = () => navigator.clipboard.writeText(backend.logs?.() || '').then(() => toast('Registro copiato'), () => toast('Copia non riuscita'));
  document.getElementById('save').onclick = async () => {
    const key = document.getElementById('key').value.trim();
    await backend.settings.set({ ANTHROPIC_API_KEY: key });
    toast(key ? 'AI attivata' : 'AI disattivata');
  };
}
