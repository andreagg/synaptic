// Scaricamento HTTP "educato": proxy da env, retry, limite di concorrenza per host,
// cache su disco dei media e rendering JS opzionale con Playwright.
import { fetch, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const PER_HOST = Number(process.env.PER_HOST_CONCURRENCY || 3);
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 150);

const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// --- semaforo per host --------------------------------------------------------
const hosts = new Map();
async function withHostSlot(url, fn) {
  const host = new URL(url).host;
  let h = hosts.get(host);
  if (!h) { h = { active: 0, queue: [] }; hosts.set(host, h); }
  if (h.active >= PER_HOST) await new Promise((r) => h.queue.push(r));
  h.active++;
  try {
    return await fn();
  } finally {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    h.active--;
    h.queue.shift()?.();
  }
}

async function request(url, { referer, accept, retries = 2, timeout = 30000 } = {}) {
  return withHostSlot(url, async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(timeout),
          headers: {
            'user-agent': UA,
            'accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
            ...(referer ? { referer } : {}),
          },
        });
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
    throw lastErr;
  });
}

/** Scarica una pagina HTML. Restituisce { url finale, html, contentType }. */
export async function fetchPage(url, { render = false, referer } = {}) {
  if (render) {
    const rendered = await renderWithBrowser(url).catch((e) => {
      console.warn('[fetch] rendering JS non disponibile:', e.message);
      return null;
    });
    if (rendered) return rendered;
  }
  const res = await request(url, { referer });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  const contentType = res.headers.get('content-type') || '';
  if (!/html|xml|text\/plain/i.test(contentType)) {
    // Non è una pagina: la trattiamo come file diretto.
    res.body?.cancel().catch(() => {});
    return { url: res.url, html: '', contentType };
  }
  return { url: res.url, html: await res.text(), contentType };
}

// --- rendering con browser headless (siti che generano il contenuto in JS) ---
let browserPromise = null;
async function renderWithBrowser(url) {
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) => chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    })).catch((e) => { browserPromise = null; throw e; });
  }
  const browser = await browserPromise;
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    // scorri per attivare il lazy-loading delle immagini
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 800) {
        window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60));
      }
    });
    return { url: page.url(), html: await page.content(), contentType: 'text/html' };
  } finally {
    await page.close();
  }
}

// --- media con cache su disco ---------------------------------------------------
const mediaKey = (url) => crypto.createHash('sha1').update(url).digest('hex');
const inflight = new Map();

/** Restituisce { file, type } dal cache, scaricandolo se serve. */
export async function getMedia(url, referer) {
  const key = mediaKey(url);
  const file = path.join(MEDIA_DIR, key);
  const meta = file + '.type';
  if (fs.existsSync(file) && fs.existsSync(meta)) return { file, type: fs.readFileSync(meta, 'utf8') };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const res = await request(url, { referer: referer || new URL(url).origin + '/', accept: '*/*', timeout: 120000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
    const type = res.headers.get('content-type') || guessType(url);
    const tmp = file + '.part';
    await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await fs.promises.rename(tmp, file);
    await fs.promises.writeFile(meta, type);
    return { file, type };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function isCached(url) {
  return fs.existsSync(path.join(MEDIA_DIR, mediaKey(url)));
}

function guessType(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.pdf': 'application/pdf', '.epub': 'application/epub+zip',
    '.cbz': 'application/vnd.comicbook+zip', '.zip': 'application/zip' })[ext] || 'application/octet-stream';
}
