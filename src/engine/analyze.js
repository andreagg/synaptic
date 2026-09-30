// Analisi euristica di una pagina HTML: capisce se è un indice di capitoli,
// un lettore di immagini (manga/fumetti), un elenco di file (PDF, CBZ, EPUB)
// o un articolo di testo. Nessuna regola specifica per sito: tutto si basa su
// pattern ricorrenti negli URL e nella struttura della pagina.
import * as cheerio from 'cheerio';

export const FILE_EXT = /\.(pdf|cbz|cbr|epub|mobi|zip|djvu)(\?|#|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i;
const ASSET_EXT = /\.(css|js|json|xml|rss|ico|svg|woff2?|ttf|mp3|mp4|webm)(\?|#|$)/i;
const JUNK_IMG = /(logo|icon|avatar|banner|sprite|emoji|smiley|button|badge|loader|loading|spinner|placeholder|pixel|blank|spacer|ads?[\/_.-]|advert|facebook|twitter|whatsapp|telegram|gravatar|flag|rating|star)/i;
const CHAPTER_WORDS = /(cap(itolo|\.)?|chap(ter)?|ch\.|episod|ep\.|volum|vol\.|tomo|issue|numero|parte|part|#\s*\d)/i;
const NEXT_WORDS = /^(next|successiv|avanti|seguente|prossim|›|»|>|→|>>|older)/i;
const CHROME_SEL = 'header, footer, nav, aside, [role=navigation], .menu, .navbar, .sidebar, .footer, .header, #menu, #sidebar, #footer, #header, .breadcrumb, .comments, #comments';

export function load(html) { return cheerio.load(html || ''); }

export function abs(href, base) {
  if (!href) return null;
  href = String(href).trim();
  if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('data:')) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Firma di un URL: stesso host e stessa forma del percorso, con i numeri generalizzati. */
export function signature(url, mode = 'strict') {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  let p;
  if (mode === 'loose') {
    // ultimo segmento generico: raggruppa slug tipo "one-piece-chapter-1100-titolo"
    p = segs.slice(0, -1).map((s) => s.replace(/\d+/g, '#')).join('/') + '/*';
  } else {
    p = segs.map((s) => s.replace(/\d+/g, '#')).join('/');
  }
  const q = [...u.searchParams.keys()].sort().join('&');
  return `${u.host}/${p}${q ? '?' + q : ''}`;
}

function sameSite(a, b) {
  const h = (x) => new URL(x).hostname.replace(/^www\./, '');
  const ha = h(a); const hb = h(b);
  return ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
}

export function pageMeta($, base) {
  const og = (p) => $(`meta[property="${p}"], meta[name="${p}"]`).attr('content');
  const title = clean(og('og:title') || $('h1').first().text() || $('title').text());
  const cover = abs(og('og:image') || og('twitter:image'), base);
  const description = clean(og('og:description') || og('description')).slice(0, 600);
  return { title, cover, description };
}

/** Tutti i link della pagina con testo e contesto. */
export function extractLinks($, base) {
  const out = [];
  const seen = new Set();
  $('a[href]').each((i, el) => {
    const url = abs($(el).attr('href'), base);
    if (!url || url === base || ASSET_EXT.test(url)) return;
    const text = clean($(el).text() || $(el).attr('title') || $(el).find('img').attr('alt'));
    const key = url;
    if (seen.has(key)) {
      // se lo stesso link compare più volte teniamo il testo più informativo
      const prev = out.find((o) => o.url === url);
      if (prev && text.length > prev.text.length) prev.text = text;
      return;
    }
    seen.add(key);
    out.push({ url, text, order: i, chrome: $(el).closest(CHROME_SEL).length > 0 });
  });
  // opzioni di <select> che puntano a URL (menu a tendina "vai al capitolo")
  $('select option').each((i, el) => {
    const v = $(el).attr('value') || $(el).attr('data-url');
    if (!v || !/[/?.]/.test(v)) return;
    const url = abs(v, base);
    if (!url || seen.has(url) || ASSET_EXT.test(url)) return;
    seen.add(url);
    out.push({ url, text: clean($(el).text()), order: 100000 + i, chrome: false, fromSelect: true });
  });
  return out;
}

/** Estrae il numero di capitolo più plausibile da testo/URL. */
export function chapterNumber(text, url) {
  const t = String(text || '');
  const m = t.match(/(?:cap(?:itolo)?|chap(?:ter)?|ch|episodio|episode|ep|numero|n|#|issue|parte|part)\.?\s*[:\-]?\s*(\d+(?:[.,]\d+)?)/i);
  if (m) return parseFloat(m[1].replace(',', '.'));
  const lone = t.match(/^\s*(\d+(?:[.,]\d+)?)\b/);
  if (lone) return parseFloat(lone[1].replace(',', '.'));
  try {
    const path = decodeURIComponent(new URL(url).pathname + new URL(url).search);
    const um = path.match(/(?:cap(?:itolo)?|chap(?:ter)?|ch|episodio|ep)[-_/.]?(\d+(?:[.-]\d+)?)/i);
    if (um) return parseFloat(um[1].replace('-', '.'));
    const nums = path.match(/\d+(?:\.\d+)?/g);
    if (nums) return parseFloat(nums[nums.length - 1]);
  } catch { /* ignore */ }
  const any = t.match(/(\d+(?:[.,]\d+)?)/);
  return any ? parseFloat(any[1].replace(',', '.')) : null;
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

/**
 * Trova l'elenco dei capitoli/elementi in una pagina indice.
 * Restituisce { items:[{title,url,sort_key}], confidence 0..1, pattern } oppure null.
 */
export function findChapterList($, base, rules = {}) {
  const links = extractLinks($, base).filter((l) => sameSite(l.url, base) && !IMG_EXT.test(l.url));
  if (rules.chapterPattern) {
    let re; try { re = new RegExp(rules.chapterPattern, 'i'); } catch { re = null; }
    if (re) {
      const hits = links.filter((l) => re.test(l.url));
      if (hits.length) return { items: toItems(hits), confidence: 0.95, pattern: rules.chapterPattern, source: 'rules' };
    }
  }

  let best = null;
  for (const mode of ['strict', 'loose']) {
    for (const [sig, group] of groupBy(links, (l) => signature(l.url, mode))) {
      if (group.length < 3) continue;
      const kw = group.filter((l) => CHAPTER_WORDS.test(l.text) || CHAPTER_WORDS.test(decodeURIComponent(l.url))).length / group.length;
      const nums = new Set(group.map((l) => chapterNumber(l.text, l.url)).filter((n) => n != null));
      const numeric = nums.size / group.length;
      const chrome = group.filter((l) => l.chrome).length / group.length;
      const texty = group.filter((l) => l.text.length > 0).length / group.length;
      let score = Math.log2(group.length + 1) * (1 + 1.5 * kw + numeric) * (1 - 0.7 * chrome) * (0.5 + 0.5 * texty);
      if (mode === 'loose') score *= 0.9;
      if (!best || score > best.score) best = { sig, group, score, kw, numeric, mode };
    }
  }
  if (!best) return null;
  const chrome = best.group.filter((l) => l.chrome).length / best.group.length;
  const confidence = Math.min(1, (0.2 + 0.08 * Math.min(best.group.length, 5) + 0.25 * best.kw + 0.15 * best.numeric) * (1 - 0.8 * chrome));
  return { items: toItems(best.group), confidence, pattern: sigToRegex(best.sig), source: 'heuristic' };
}

function toItems(group) {
  let items = group.map((l) => ({
    title: l.text || decodeURIComponent(new URL(l.url).pathname.split('/').filter(Boolean).pop() || l.url),
    url: l.url,
    num: chapterNumber(l.text, l.url),
    order: l.order,
  }));
  const withNum = items.filter((i) => i.num != null).length;
  if (withNum >= items.length * 0.7) {
    items.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || a.order - b.order);
  } else {
    items.sort((a, b) => a.order - b.order);
    // molti siti elencano dal più recente: se i numeri noti decrescono, invertiamo
    const known = items.filter((i) => i.num != null);
    if (known.length >= 2 && known[0].num > known[known.length - 1].num) items.reverse();
  }
  return items.map((i, idx) => ({ title: i.title.slice(0, 200), url: i.url, sort_key: i.num ?? idx, _idx: idx }))
    .map(({ _idx, ...rest }) => rest);
}

/** Trasforma una firma in una regex riutilizzabile per i controlli futuri. */
function sigToRegex(sig) {
  const [hostPath, query] = sig.split('?');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = esc(hostPath).replace(/#/g, '\\d+').replace(/\\\*$/, '[^/]+');
  re = '^https?://' + re + '/?';
  if (query) re += '\\?.*';
  return re + '$';
}

/** Link diretti a file (PDF, CBZ, EPUB...). */
export function findFiles($, base) {
  const out = [];
  const seen = new Set();
  $('a[href], iframe[src], embed[src], object[data]').each((i, el) => {
    const raw = $(el).attr('href') || $(el).attr('src') || $(el).attr('data');
    const url = abs(raw, base);
    if (!url || seen.has(url)) return;
    // lettori PDF incorporati tipo ...viewer.html?file=xxx.pdf
    let target = url;
    try {
      const f = new URL(url).searchParams.get('file') || new URL(url).searchParams.get('url');
      if (f && FILE_EXT.test(f)) target = abs(f, url);
    } catch { /* ignore */ }
    if (!FILE_EXT.test(target)) return;
    seen.add(url);
    const ext = target.match(FILE_EXT)[1].toLowerCase();
    const text = clean($(el).text() || $(el).attr('title')) || decodeURIComponent(new URL(target).pathname.split('/').pop());
    out.push({ url: target, title: text.slice(0, 200), ext, order: i });
  });
  return out;
}

function bestFromSrcset(srcset) {
  if (!srcset) return null;
  const parts = srcset.split(',').map((p) => p.trim().split(/\s+/)).filter((p) => p[0]);
  parts.sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0));
  return parts[0]?.[0] || null;
}

/** Tutte le immagini candidate (anche lazy-load e quelle dentro gli script). */
export function imageCandidates($, html, base) {
  const out = [];
  const seen = new Set();
  const push = (raw, info = {}) => {
    const url = abs(raw, base);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, order: out.length, ...info });
  };
  const scan = ($$) => {
    $$('img, source, [data-src], [data-bg]').each((i, el) => {
      const $el = $$(el);
      const src = $el.attr('data-src') || $el.attr('data-lazy-src') || $el.attr('data-original') ||
        $el.attr('data-url') || $el.attr('data-srcset')?.split(' ')[0] || $el.attr('data-bg') ||
        bestFromSrcset($el.attr('srcset')) || $el.attr('src');
      if (!src || src.startsWith('data:')) return;
      const w = parseInt($el.attr('width'), 10); const h = parseInt($el.attr('height'), 10);
      push(src, {
        alt: clean($el.attr('alt')),
        small: (w && w < 150) || (h && h < 150),
        chrome: $el.closest(CHROME_SEL).length > 0,
      });
    });
  };
  scan($);
  $('noscript').each((i, el) => scan(cheerio.load($(el).text() || $(el).html() || '')));
  // URL di immagini dentro script inline (array di pagine nei lettori JS)
  $('script:not([src])').each((i, el) => {
    const code = $(el).html() || '';
    const re = /["'`]((?:https?:)?(?:\\?\/|[\w.-])[^"'`\s]*?\.(?:jpe?g|png|webp|avif|gif))(?:\?[^"'`\s]*)?["'`]/gi;
    let m;
    while ((m = re.exec(code))) push(m[1].replace(/\\\//g, '/'), { fromScript: true });
  });
  return out;
}

/**
 * Trova le immagini "di contenuto" (le pagine del fumetto) in una pagina.
 * Restituisce { images:[url], confidence, pattern }.
 */
export function findImages($, html, base, rules = {}) {
  let cands = imageCandidates($, html, base);
  if (rules.imagePattern) {
    let re; try { re = new RegExp(rules.imagePattern, 'i'); } catch { re = null; }
    if (re) {
      const hits = cands.filter((c) => re.test(c.url));
      if (hits.length) return { images: hits.map((h) => h.url), confidence: 0.95, pattern: rules.imagePattern };
    }
  }
  cands = cands.filter((c) => !c.small && !c.chrome && !JUNK_IMG.test(c.url) && !/\.svg(\?|$)/i.test(c.url));
  if (!cands.length) return { images: [], confidence: 0 };
  const groups = [...groupBy(cands, (c) => signature(c.url, 'strict')).entries()]
    .map(([sig, g]) => ({ sig, g }))
    .concat([...groupBy(cands, (c) => signature(c.url, 'loose')).entries()].map(([sig, g]) => ({ sig, g, loose: true })));
  groups.sort((a, b) => b.g.length - a.g.length || (a.loose ? 1 : -1));
  const best = groups[0];
  if (best.g.length >= 2) {
    const imgs = best.g.sort((a, b) => a.order - b.order).map((c) => c.url);
    return { images: imgs, confidence: Math.min(1, 0.4 + 0.1 * imgs.length), pattern: sigToRegex(best.sig) };
  }
  // una sola immagine grande: probabilmente un lettore "una pagina alla volta"
  const main = cands.find((c) => IMG_EXT.test(c.url)) || cands[0];
  return { images: [main.url], confidence: 0.3, single: true, pattern: sigToRegex(signature(main.url)) };
}

/**
 * Per lettori "una pagina per URL": individua gli URL delle altre pagine dello stesso capitolo.
 */
export function findReaderPages($, base) {
  const links = extractLinks($, base);
  const baseSig = signature(base);
  const baseU = new URL(base);
  const baseSegs = baseU.pathname.split('/').filter(Boolean);
  const pages = new Map();
  for (const l of links) {
    const u = new URL(l.url);
    if (u.host !== baseU.host) continue;
    const segs = u.pathname.split('/').filter(Boolean);
    const sig = signature(l.url);
    let n = null;
    const qDiff = u.pathname === baseU.pathname ? queryNumberDiff(baseU, u) : null;
    if (qDiff != null) {
      n = qDiff; // stessa pagina, cambia solo ?pagina=N
    } else if (sig === baseSig) {
      // differisce solo per un numero (es. /cap-5/3 vs /cap-5/4 oppure ?page=4)
      const diffs = diffNumbers(base, l.url);
      if (diffs.length === 1) n = diffs[0];
    } else if (segs.length === baseSegs.length + 1 && baseSegs.every((s, i) => s === segs[i]) && /^\d+$/.test(segs.at(-1))) {
      n = parseInt(segs.at(-1), 10); // /capitolo-5 → /capitolo-5/2
    } else if (segs.length === baseSegs.length && /^\d+$/.test(segs.at(-1) || '') && !/\d/.test(baseSegs.at(-1) || 'x')) {
      continue;
    }
    if (n != null && Number.isFinite(n) && !pages.has(n)) pages.set(n, l.url);
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([n, url]) => ({ n, url }));
}

function queryNumberDiff(a, b) {
  const keys = new Set([...a.searchParams.keys(), ...b.searchParams.keys()]);
  let found = null;
  for (const k of keys) {
    const va = a.searchParams.get(k); const vb = b.searchParams.get(k);
    if (va === vb) continue;
    if (vb == null || !/^\d+$/.test(vb) || found != null) return null;
    found = parseInt(vb, 10);
  }
  return found;
}

function diffNumbers(a, b) {
  const na = a.match(/\d+/g) || []; const nb = b.match(/\d+/g) || [];
  if (na.length !== nb.length) return [];
  const out = [];
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) out.push(parseInt(nb[i], 10));
  return out;
}

/** Link "pagina successiva" (sia per indici paginati che per lettori). */
export function findNextLink($, base) {
  const rel = abs($('link[rel=next], a[rel=next]').first().attr('href'), base);
  if (rel) return rel;
  let found = null;
  $('a[href]').each((i, el) => {
    if (found) return;
    const $el = $(el);
    const t = clean($el.text() || $el.attr('title') || $el.attr('aria-label'));
    const cls = ($el.attr('class') || '') + ' ' + ($el.attr('id') || '');
    if (NEXT_WORDS.test(t) || /\bnext\b|successiv/i.test(cls)) {
      const u = abs($el.attr('href'), base);
      if (u && u !== base && sameSite(u, base)) found = u;
    }
  });
  return found;
}

/** Estrae il testo principale (per articoli / romanzi web). */
export function extractArticle($) {
  $('script, style, noscript, iframe, form, ' + CHROME_SEL).remove();
  let best = null; let bestScore = 0;
  $('article, main, [role=main], .content, .entry-content, .post, #content, div, section').each((i, el) => {
    const $el = $(el);
    const pText = $el.children('p').text().length;
    const all = $el.text().length;
    const linkText = $el.find('a').text().length;
    const score = pText * 1.5 + all * 0.2 - linkText * 1.5;
    if (score > bestScore) { bestScore = score; best = $el; }
  });
  if (!best) return { html: '', length: 0 };
  const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'em', 'strong', 'b', 'i', 'br', 'img', 'figure', 'figcaption', 'pre', 'code']);
  best.find('*').each((i, el) => {
    if (!allowed.has(el.tagName)) { $(el).replaceWith($(el).contents()); return; }
    for (const a of Object.keys(el.attribs || {})) if (!(el.tagName === 'img' && a === 'src')) $(el).removeAttr(a);
  });
  const html = best.html() || '';
  return { html, length: best.text().trim().length };
}

/** Riassunto compatto della pagina da passare all'AI. */
export function summarizeForAI($, html, base) {
  const meta = pageMeta($, base);
  const links = extractLinks($, base).slice(0, 400).map((l) => `${l.text.slice(0, 80)} | ${l.url}`);
  const imgs = imageCandidates($, html, base).slice(0, 150).map((c) => c.url);
  const $$ = load(html);
  $$('script, style, noscript, svg').remove();
  const text = clean($$('body').text()).slice(0, 3000);
  return { url: base, ...meta, links, images: imgs, text };
}
