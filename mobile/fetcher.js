// Sostituto mobile di src/fetcher.js. Sul telefono usa l'HTTP nativo di Capacitor:
// niente CORS, User-Agent e Referer impostabili (contro i blocchi hotlink).
// In un browser normale (sviluppo) ripiega su fetch().
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { InAppBrowser, ToolBarType } from '@capgo/inappbrowser';
import { idbGet, idbSet, idbKeys } from './idb.js';

const native = Capacitor.isNativePlatform();
// Stesso User-Agent della WebView: i cookie di verifica (es. Cloudflare) sono legati a UA e IP,
// così quelli ottenuti nel browser interno valgono anche per le richieste native.
const UA = navigator.userAgent;
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
};
const IMG_HEADERS = {
  'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'same-origin',
};
const CHALLENGE = /cf-chl|challenge-platform|cf_chl_opt|Just a moment\.\.\.|Checking your browser|Attention Required!|DDoS protection by|ddos-guard|Verifica di sicurezza|captcha-delivery/i;
export const isChallenge = (html) => CHALLENGE.test(String(html || '').slice(0, 20000));
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
            headers: { ...(binary ? IMG_HEADERS : BROWSER_HEADERS), ...(referer ? { Referer: referer } : {}) },
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

export async function fetchPage(url, { referer, render = false } = {}) {
  if (/\.(pdf|cbz|cbr|epub|zip|jpe?g|png|webp)(\?|#|$)/i.test(url)) return { url, html: '', contentType: '' };
  if (render && native) return fetchViaWebView(url, { visible: false });
  const res = await request(url, { referer });
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
  // protezione anti-bot: apriamo la pagina in un browser vero (cookie condivisi con le richieste native)
  if (native && ([403, 503, 429].includes(res.status) || isChallenge(html))) {
    return fetchViaWebView(url, { visible: true });
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status} su ${url}`);
  if (res.type && !/html|xml|text\/plain/i.test(res.type)) return { url: res.url, html: '', contentType: res.type };
  return { url: res.url, html, contentType: res.type || 'text/html' };
}

// --- browser interno: supera le verifiche anti-bot e i siti che generano tutto in JavaScript ---
let webviewLock = Promise.resolve();
export function fetchViaWebView(url, { visible = true, timeout = 90000 } = {}) {
  const run = () => new Promise((resolve, reject) => {
    const handles = [];
    let done = false; let poll = null; let timer = null;
    const finish = async (err, value) => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(timer);
      for (const h of handles) h.remove?.();
      await InAppBrowser.close().catch(() => {});
      err ? reject(err) : resolve(value);
    };
    (async () => {
      handles.push(await InAppBrowser.addListener('messageFromWebview', (ev) => {
        const d = ev?.detail?.detail || ev?.detail || ev || {};
        if (d.synHtml && !isChallenge(d.synHtml) && d.synReady) finish(null, { url: d.url || url, html: d.synHtml, contentType: 'text/html' });
      }));
      handles.push(await InAppBrowser.addListener('closeEvent', () => finish(new Error('Verifica del sito annullata: riprova con "Cerca aggiornamenti"'))));
      await InAppBrowser.openWebView({
        url, title: visible ? 'Verifica del sito… attendi o completa il controllo' : 'Caricamento…',
        toolbarType: ToolBarType.COMPACT, visibleTitle: true, toolbarColor: '#14151a', toolbarTextColor: '#ffffff',
        isPresentAfterPageLoad: !visible,
      });
      const code = `try{var h=document.documentElement.outerHTML;window.mobileApp.postMessage({detail:{synHtml:h,url:location.href,synReady:document.readyState==='complete'}})}catch(e){}`;
      poll = setInterval(() => InAppBrowser.executeScript({ code }).catch(() => {}), 1500);
      timer = setTimeout(() => finish(new Error('Il sito non ha superato la verifica in tempo')), timeout);
    })().catch((e) => finish(e));
  });
  const p = webviewLock.then(run, run);
  webviewLock = p.catch(() => {});
  return p;
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
