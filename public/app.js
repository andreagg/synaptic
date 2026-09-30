// Frontend a pagina singola, senza framework. Rotte: #/  #/book/:id  #/read/:chapterId
const $view = document.getElementById('view');
const api = async (path, opts = {}) => {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const media = (u, ref) => `/api/media?u=${encodeURIComponent(u)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };
const KIND = { manga: '📖 Fumetto', series: '📚 Serie', pdf: '📄 PDF', article: '📰 Testo', mixed: '🗂️ Misto', unknown: '…' };
const ICON = { images: '🖼️', pdf: '📄', file: '📦', html: '📰', page: '•' };

let timer = null;
const poll = (fn, ms = 2000) => { clearInterval(timer); timer = setInterval(fn, ms); };

// ---------------------------------------------------------------- libreria
async function renderLibrary() {
  document.body.classList.remove('reading');
  const books = await api('/books');
  if (!books.length) {
    $view.innerHTML = `<div class="empty"><div class="big">📚</div><h2>La tua libreria è vuota</h2>
      <p>Aggiungi l'indirizzo di un sito con fumetti, capitoli, PDF o articoli:<br>verrà trasformato in un libro da leggere qui.</p>
      <button class="btn primary" onclick="document.getElementById('addBtn').click()">+ Aggiungi la prima fonte</button></div>`;
    return;
  }
  $view.innerHTML = `<div class="grid">${books.map((b) => `
    <a class="card" href="#/book/${b.id}">
      ${b.new_count ? `<span class="badge">+${b.new_count}</span>` : ''}
      <div class="cover" style="${b.cover ? `background-image:url('${media(b.cover, b.source_url)}')` : ''}">${b.cover ? '' : '📘'}</div>
      <div class="info"><h3>${esc(b.title)}</h3>
        <div class="meta">${statusPill(b)} ${b.chapter_count} elem. · letti ${b.read_count}</div></div>
    </a>`).join('')}</div>`;
  if (books.some((b) => b.busy || ['scanning', 'downloading'].includes(b.status))) poll(renderLibrary, 2500);
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
async function renderBook(id) {
  document.body.classList.remove('reading');
  const b = await api(`/books/${id}`);
  const busy = b.busy || ['scanning', 'downloading'].includes(b.status);
  let chs = b.chapters;
  if (filter) chs = chs.filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()));
  if (sortDesc) chs = [...chs].reverse();
  const lastRead = [...b.chapters].filter((c) => c.read_at).sort((x, y) => y.read_at - x.read_at)[0];
  const cont = lastRead || b.chapters[0];
  $view.innerHTML = `
    <section class="hero">
      <div class="cover" style="${b.cover ? `background-image:url('${media(b.cover, b.source_url)}')` : ''}">${b.cover ? '' : '📘'}</div>
      <div>
        <h1>${esc(b.title)}</h1>
        <div class="src"><a href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(b.source_url)}</a></div>
        <p class="muted">${esc(b.description || '')}</p>
        <div class="row">
          ${cont ? `<a class="btn primary" href="#/read/${cont.id}">${lastRead ? '▶ Continua' : '▶ Inizia a leggere'}</a>` : ''}
          <button class="btn" id="scan" ${busy ? 'disabled' : ''}>⟳ Cerca aggiornamenti</button>
          <button class="btn" id="dl" ${busy ? 'disabled' : ''}>⬇ Scarica offline</button>
        </div>
        <div class="status">${busy ? '<span class="spinner"></span>' : ''}<span>${esc(b.message || '')}</span></div>
        <div class="row muted" style="font-size:13px">
          <span>${KIND[b.kind] || ''}</span> ·
          <label>Aggiorna <select id="every" style="width:auto;padding:4px 8px">
            ${[[0, 'mai'], [1, 'ogni ora'], [6, 'ogni 6 ore'], [24, 'ogni giorno'], [168, 'ogni settimana']]
              .map(([v, l]) => `<option value="${v}" ${Number(b.update_hours) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label> ·
          <label class="check" style="display:inline-flex"><input type="checkbox" id="ai" ${b.use_ai ? 'checked' : ''}> AI</label>
          <label class="check" style="display:inline-flex"><input type="checkbox" id="js" ${b.render_js ? 'checked' : ''}> JS</label>
          <button class="btn danger" id="del" style="padding:4px 10px">Elimina</button>
        </div>
      </div>
    </section>
    <div class="toolbar">
      <strong>${b.chapters.length} elementi${b.chapters.some((c) => c.is_new) ? ` · <span style="color:var(--accent)">${b.chapters.filter((c) => c.is_new).length} nuovi</span>` : ''}</strong>
      <div class="row"><input id="q" placeholder="Cerca…" value="${esc(filter)}"><button class="btn" id="sort">${sortDesc ? '↑' : '↓'}</button></div>
    </div>
    <ul class="chapters">${chs.map((c) => `
      <li class="${c.read_at ? 'read' : ''}"><a href="#/read/${c.id}">
        <span class="ico">${c.status === 'error' ? '⚠️' : ICON[c.type] || '•'}</span>
        <span class="t">${esc(c.title)}</span>
        ${c.is_new ? '<span class="dot" title="Nuovo"></span>' : ''}
        ${c.read_at ? '<span class="pill ok">letto</span>' : ''}
      </a></li>`).join('')}</ul>`;

  const q = document.getElementById('q');
  q.oninput = () => { filter = q.value; renderBook(id).then(() => { const n = document.getElementById('q'); n.focus(); n.setSelectionRange(filter.length, filter.length); }); };
  document.getElementById('sort').onclick = () => { sortDesc = !sortDesc; renderBook(id); };
  document.getElementById('scan').onclick = async () => { await api(`/books/${id}/scan`, { method: 'POST' }); toast('Controllo aggiornamenti avviato'); setTimeout(() => renderBook(id), 300); };
  document.getElementById('dl').onclick = async () => { await api(`/books/${id}/download`, { method: 'POST' }); toast('Download avviato'); setTimeout(() => renderBook(id), 300); };
  document.getElementById('every').onchange = (e) => api(`/books/${id}`, { method: 'PATCH', body: { update_hours: Number(e.target.value) } }).then(() => toast('Salvato'));
  document.getElementById('ai').onchange = (e) => api(`/books/${id}`, { method: 'PATCH', body: { use_ai: e.target.checked } });
  document.getElementById('js').onchange = (e) => api(`/books/${id}`, { method: 'PATCH', body: { render_js: e.target.checked } });
  document.getElementById('del').onclick = async () => { if (confirm('Eliminare questo libro dalla libreria?')) { await api(`/books/${id}`, { method: 'DELETE' }); location.hash = '#/'; } };
  if (busy) poll(() => renderBook(id), 2000); else clearInterval(timer);
}

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
      <div class="title"><div class="muted" style="font-size:11px">${esc(ch.book.title)}</div>${esc(ch.title)}</div>
      ${ch.prev ? `<a class="btn" href="#/read/${ch.prev.id}" title="Precedente">‹</a>` : ''}
      ${ch.next ? `<a class="btn" href="#/read/${ch.next.id}" title="Successivo">›</a>` : ''}
    </div><div class="progress" id="prog"></div>`;
  const nav = `<div class="reader-nav">
      ${ch.prev ? `<a class="btn" href="#/read/${ch.prev.id}">‹ ${esc(ch.prev.title)}</a>` : ''}
      ${ch.next ? `<a class="btn primary" href="#/read/${ch.next.id}">${esc(ch.next.title)} ›</a>` : `<a class="btn" href="#/book/${ch.book.id}">Fine · torna al libro</a>`}
    </div>`;
  const ref = ch.content?.referer || ch.url;
  if (ch.type === 'images') {
    $view.innerHTML = bar + `<div class="pages">${ch.content.images.map((u, i) =>
      `<img loading="${i < 3 ? 'eager' : 'lazy'}" src="${media(u, ref)}" alt="Pagina ${i + 1}" onload="this.classList.add('loaded')">`).join('')}</div>` + nav;
  } else if (ch.type === 'pdf') {
    $view.innerHTML = bar + `<iframe class="pdf" src="${media(ch.content.url, ref)}"></iframe>`;
  } else if (ch.type === 'html') {
    $view.innerHTML = bar + `<article class="article">${ch.content.html}</article>` + nav;
    $view.querySelectorAll('.article img').forEach((img) => { img.src = media(new URL(img.getAttribute('src'), ch.url).href, ch.url); });
  } else {
    $view.innerHTML = bar + `<div class="empty"><div class="big">📦</div><p>File scaricabile</p>
      <a class="btn primary" href="${media(ch.content.url, ref)}" download>Scarica</a></div>`;
  }
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
  if (ch.next) setTimeout(() => api(`/chapters/${ch.next.id}`).catch(() => {}), 1500);
}

// ---------------------------------------------------------------- router
async function route() {
  window.onscroll = null; $view.onclick = null;
  const h = location.hash || '#/';
  let m;
  try {
    if ((m = h.match(/^#\/book\/(\d+)/))) { await renderBook(m[1]); await api(`/books/${m[1]}/seen`, { method: 'POST' }).catch(() => {}); }
    else if ((m = h.match(/^#\/read\/(\d+)/))) await renderReader(m[1]);
    else { clearInterval(timer); await renderLibrary(); }
    if (!h.startsWith('#/read')) scrollTo(0, 0);
  } catch (e) { $view.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p></div>`; }
}
addEventListener('hashchange', route);
route();

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
