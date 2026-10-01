// Sostituto mobile di src/fetcher.js. Sul telefono usa l'HTTP nativo di Capacitor:
// niente CORS, User-Agent e Referer impostabili (contro i blocchi hotlink).
// In un browser normale (sviluppo) ripiega su fetch().
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { idbGet, idbSet, idbKeys } from './idb.js';

const native = Capacitor.isNativePlatform();
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const PER_HOST = 3;

const hosts = new Map();
async function withHostSlot(url, fn) {
  const host = new URL(url).host;
  let h = hosts.get(host);
  if (!h) { h = { active: 0, queue: [] }; hosts.set(host, h); }
  if (h.active >= PER_HOST) await new Promise((r) => h.queue.push(r));
  h.active++;
  try { return await fn(); } finally {
    await new Promise((r) => setTimeout(r, 120));
    h.active--; h.queue.shift()?.();
  }
}

const lower = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

async function request(url, { referer, binary = false, retries = 2 } = {}) {
  return withHostSlot(url, async () => {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        let res;
        if (native) {
          const r = await CapacitorHttp.request({
            url, method: 'GET', responseType: binary ? 'blob' : 'text', connectTimeout: 30000, readTimeout: 60000,
            headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', ...(referer ? { Referer: referer } : {}) },
          });
          const headers = lower(r.headers);
          res = { status: r.status, url: r.url || url, type: headers['content-type'] || '', data: r.data };
          if (binary && typeof res.data === 'string') res.data = b64ToBlob(res.data, res.type);
        } else {
          const r = await fetch(url, { redirect: 'follow' });
          res = { status: r.status, url: r.url, type: r.headers.get('content-type') || '', data: binary ? await r.blob() : await r.text() };
        }
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        last = e;
        if (i < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
      }
    }
    throw last;
  });
}

function b64ToBlob(b64, type) {
  const bin = atob(b64.replace(/^data:[^,]*,/, ''));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: type || 'application/octet-stream' });
}

export async function fetchPage(url, { referer } = {}) {
  if (/\.(pdf|cbz|cbr|epub|zip|jpe?g|png|webp)(\?|#|$)/i.test(url)) return { url, html: '', contentType: '' };
  const res = await request(url, { referer });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} su ${url}`);
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.type && !/html|xml|text\/plain/i.test(res.type)) return { url: res.url, html: '', contentType: res.type };
  return { url: res.url, html, contentType: res.type || 'text/html' };
}

// --- media: cache permanente in IndexedDB, URL "blob:" in memoria -----------------
const cached = new Set();
const objectUrls = new Map();
const inflight = new Map();
export async function initMedia() {
  for (const k of await idbKeys('media').catch(() => [])) cached.add(k);
}
export const isCached = (url) => cached.has(url);

export async function getMedia(url, referer) {
  if (cached.has(url)) {
    const rec = await idbGet('media', url);
    if (rec) return rec;
  }
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const res = await request(url, { referer: referer || new URL(url).origin + '/', binary: true });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const rec = { blob: res.data, type: res.type || res.data.type };
    await idbSet('media', url, rec);
    cached.add(url);
    return rec;
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

export async function mediaObjectUrl(url, referer) {
  if (objectUrls.has(url)) return objectUrls.get(url);
  const { blob } = await getMedia(url, referer);
  const o = URL.createObjectURL(blob);
  objectUrls.set(url, o);
  return o;
}
