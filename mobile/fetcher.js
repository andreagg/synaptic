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
// Pagina di verifica anti-bot: si riconosce dal titolo o da marcatori della challenge.
// (Non basta "challenge-platform": Cloudflare inserisce quello script anche nelle pagine normali.)
const CHALLENGE_TITLE = /<title>\s*(Just a moment|Ci siamo quasi|Un momento|Attention Required|Please Wait|Verifica|DDoS-Guard|Checking your browser)/i;
const CHALLENGE_MARK = /cf_chl_opt|cf-chl-widget|challenges\.cloudflare\.com\/turnstile|ddos-guard\.net\/|captcha-delivery\.com/i;
export const isChallenge = (html) => {
  const h = String(html || '');
  return CHALLENGE_TITLE.test(h.slice(0, 5000)) || (h.length < 60000 && CHALLENGE_MARK.test(h));
};
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
        console.log(`[http] ${res.status} ${binary ? 'media' : 'pagina'} ${url}`);
        if (res.status >= 500 && res.status !== 503) throw new Error(`HTTP ${res.status}`);
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
    console.log(`[verifica] ${url} protetto (HTTP ${res.status}): apro il browser interno`);
    browserHosts.add(new URL(url).host);
    return fetchViaWebView(url, { visible: true });
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status} su ${url}`);
  if (res.type && !/html|xml|text\/plain/i.test(res.type)) return { url: res.url, html: '', contentType: res.type };
  return { url: res.url, html, contentType: res.type || 'text/html' };
}

// host che richiedono il browser interno (per non aprirlo durante i precaricamenti)
const browserHosts = new Set();
export const needsBrowser = (url) => { try { return browserHosts.has(new URL(url).host); } catch { return false; } };

// --- browser interno: supera le verifiche anti-bot e i siti che generano tutto in JavaScript ---
let webviewLock = Promise.resolve();
export function fetchViaWebView(url, { visible = true, timeout = 90000 } = {}) {
  const run = () => new Promise((resolve, reject) => {
    const handles = [];
    if (session.open) console.warn('[browser] sessione immagini ancora aperta');
    let done = false; let poll = null; let timer = null; let lastLen = -1;
    const finish = async (err, value) => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(timer);
      for (const h of handles) h.remove?.();
      await InAppBrowser.close().catch(() => {});
      if (err) console.warn(`[browser] ${err.message}`);
      err ? reject(err) : resolve(value);
    };
    (async () => {
      handles.push(await InAppBrowser.addListener('messageFromWebview', (ev) => {
        const d = ev?.detail?.detail || ev?.detail || ev || {};
        if (!d.synHtml) return;
        const blocked = isChallenge(d.synHtml);
        console.log(`[browser] ${d.url} ${d.synHtml.length} byte, ${blocked ? 'ancora in verifica' : d.synReady ? 'pronta' : 'in caricamento'}`);
        // aspettiamo due letture uguali a pagina pronta: gli script del sito hanno finito di riempirla
        if (!blocked && d.synReady) {
          if (lastLen === d.synHtml.length) finish(null, { url: d.url || url, html: d.synHtml, contentType: 'text/html' });
          lastLen = d.synHtml.length;
        } else lastLen = -1;
      }));
      handles.push(await InAppBrowser.addListener('closeEvent', () => finish(new Error('Verifica del sito annullata: riprova con "Cerca aggiornamenti"'))));
      await InAppBrowser.openWebView({
        url, title: visible ? 'Verifica del sito… attendi o completa il controllo' : 'Caricamento…',
        toolbarType: ToolBarType.COMPACT, visibleTitle: true, toolbarColor: '#14151a', toolbarTextColor: '#ffffff',
        isPresentAfterPageLoad: !visible,
      });
      const code = `try{var m={detail:{synHtml:document.documentElement.outerHTML,url:location.href,synReady:document.readyState==='complete'}};`
        + `if(window.mobileApp&&window.mobileApp.postMessage){window.mobileApp.postMessage(m)}else if(window.AndroidInterface){window.AndroidInterface.postMessage(JSON.stringify(m))}}catch(e){}`;
      console.log(`[browser] aperto ${url}`);
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
// host le cui immagini non si scaricano con l'HTTP nativo (anti-bot): si passa dal browser interno
const mediaBlocked = new Set();
export const isMediaBlocked = (url) => { try { return mediaBlocked.has(new URL(url).host); } catch { return false; } };

export async function initMedia() {
  for (const k of await idbKeys('media').catch(() => [])) cached.add(k);
}
export const isCached = (url) => cached.has(url);

const okImage = (status, type) => status >= 200 && status < 300 && !/text\/html/i.test(type || '');

/**
 * Scarica (e mette in cache) un'immagine o un file.
 * allowBrowser: se l'HTTP nativo è bloccato, usa la sessione nel browser interno (visibile).
 */
export async function getMedia(url, referer, { allowBrowser = true } = {}) {
  if (cached.has(url)) {
    const rec = await idbGet('media', url);
    if (rec) return rec;
  }
  const key = url + (allowBrowser ? '' : '#nb');
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let rec = null;
    if (!isMediaBlocked(url) || !native) {
      try {
        const res = await request(url, { referer: referer || new URL(url).origin + '/', binary: true, retries: 1 });
        if (okImage(res.status, res.type)) rec = { blob: res.data, type: res.type || res.data.type };
        else {
          console.warn(`[media] HTTP ${res.status} (${res.type || '?'}) ${url}`);
          if (native && [401, 403, 429, 503].includes(res.status) || /text\/html/i.test(res.type || '')) {
            mediaBlocked.add(new URL(url).host);
            console.warn(`[media] ${new URL(url).host}: download nativo bloccato, userò il browser interno`);
          }
        }
      } catch (e) { console.warn(`[media] errore ${e.message} ${url}`); }
    }
    if (!rec && native && allowBrowser) {
      const r = await browserFetch(url, { pageUrl: new URL(url).origin + '/' });
      if (!okImage(r.status, r.type) || !r.data) throw new Error(`HTTP ${r.status || r.error} (browser) su ${url}`);
      rec = { blob: b64ToBlob(r.data, r.type), type: r.type };
    }
    if (!rec) throw new Error(`download non riuscito: ${url}`);
    await idbSet('media', url, rec);
    cached.add(url);
    return rec;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** URL da mostrare nell'app (blob dalla cache). Non apre mai il browser interno. */
export async function mediaObjectUrl(url, referer) {
  if (objectUrls.has(url)) return objectUrls.get(url);
  const { blob } = await getMedia(url, referer, { allowBrowser: false });
  const o = URL.createObjectURL(blob);
  objectUrls.set(url, o);
  return o;
}

/** Verifica se un'immagine esiste (per le pagine numerate in sequenza). */
export async function probeUrl(url, referer) {
  if (cached.has(url)) return true;
  if (native && isMediaBlocked(url)) {
    const r = await browserFetch(url, { pageUrl: new URL(url).origin + '/', probe: true }).catch(() => ({ status: 0 }));
    console.log(`[http] ${r.status} prova (browser) ${url}`);
    return okImage(r.status, r.type);
  }
  return withHostSlot(url, async () => {
    try {
      if (native) {
        // GET del primo byte: più affidabile di HEAD con l'HTTP nativo e con alcuni server
        const r = await CapacitorHttp.request({ url, method: 'GET', responseType: 'text',
          headers: { ...IMG_HEADERS, Range: 'bytes=0-0', ...(referer ? { Referer: referer } : {}) }, connectTimeout: 20000, readTimeout: 20000 });
        const type = lower(r.headers)['content-type'] || '';
        console.log(`[http] ${r.status} prova ${url}`);
        if ([401, 403, 429, 503].includes(r.status) || (/text\/html/i.test(type) && r.status < 300)) {
          mediaBlocked.add(new URL(url).host);
          console.warn(`[media] ${new URL(url).host}: prove native bloccate (HTTP ${r.status}), userò il browser interno`);
          return probeUrl(url, referer);
        }
        return okImage(r.status, type);
      }
      const r = await fetch(url, { method: 'HEAD' });
      return okImage(r.status, r.headers.get('content-type'));
    } catch (e) { console.warn(`[http] prova fallita ${e.message} ${url}`); return false; }
  });
}

// --- sessione nel browser interno per scaricare immagini dal sito stesso ---------------
// Resta aperta finché arrivano richieste (si chiude dopo qualche secondo di inattività).
const session = { open: false, opening: null, origin: null, seq: 0, pending: new Map(), handles: [], idle: null, release: null };

async function closeSession() {
  if (!session.open) return;
  session.open = false;
  clearTimeout(session.idle);
  for (const h of session.handles) h.remove?.();
  session.handles = [];
  for (const [, p] of session.pending) p.reject(new Error('browser chiuso'));
  session.pending.clear();
  await InAppBrowser.close().catch(() => {});
  console.log('[browser] sessione immagini chiusa');
  session.release?.(); session.release = null;
}

async function ensureSession(pageUrl) {
  const origin = new URL(pageUrl).origin;
  if (session.open && session.origin === origin) return;
  if (session.open) await closeSession();
  if (session.opening) return session.opening;
  session.opening = (async () => {
    // prende il "turno" del browser interno (uno alla volta)
    let release;
    const turn = new Promise((r) => { release = r; });
    const prev = webviewLock;
    webviewLock = prev.then(() => turn);
    await prev;
    session.release = release;
    await new Promise((resolve, reject) => {
      let lastLen = -1; let poll = null;
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('il sito non si è aperto in tempo')); }, 90000);
      (async () => {
        session.handles.push(await InAppBrowser.addListener('messageFromWebview', (ev) => {
          const d = ev?.detail?.detail || ev?.detail || ev || {};
          if (d.synReq != null) {
            const p = session.pending.get(d.synReq);
            if (p) { session.pending.delete(d.synReq); p.resolve(d); }
            return;
          }
          if (d.synHtml != null && !session.open) {
            if (!isChallenge(d.synHtml) && d.synReady) {
              if (lastLen === d.synHtml.length) { clearInterval(poll); clearTimeout(timer); resolve(); }
              lastLen = d.synHtml.length;
            } else lastLen = -1;
          }
        }));
        session.handles.push(await InAppBrowser.addListener('closeEvent', () => { closeSession(); reject(new Error('browser chiuso')); }));
        await InAppBrowser.openWebView({ url: pageUrl, title: 'Scarico le pagine dal sito…', toolbarType: ToolBarType.COMPACT,
          visibleTitle: true, toolbarColor: '#14151a', toolbarTextColor: '#ffffff' });
        console.log(`[browser] sessione immagini aperta su ${origin}`);
        const code = `try{var m={detail:{synHtml:document.title+'|'+document.documentElement.outerHTML.length+(document.documentElement.outerHTML.slice(0,3000)),url:location.href,synReady:document.readyState==='complete'}};`
          + `(window.mobileApp&&window.mobileApp.postMessage)?window.mobileApp.postMessage(m):window.AndroidInterface.postMessage(JSON.stringify(m))}catch(e){}`;
        poll = setInterval(() => InAppBrowser.executeScript({ code }).catch(() => {}), 1200);
      })().catch(reject);
    });
    session.open = true; session.origin = origin;
  })().catch(async (e) => { await closeSession(); session.release?.(); throw e; }).finally(() => { session.opening = null; });
  return session.opening;
}

async function browserFetch(url, { pageUrl, probe = false } = {}) {
  await ensureSession(pageUrl || new URL(url).origin + '/');
  clearTimeout(session.idle);
  const id = ++session.seq;
  const result = new Promise((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    setTimeout(() => { if (session.pending.delete(id)) reject(new Error('tempo scaduto')); }, 60000);
  });
  const code = `(async function(){function post(m){m={detail:m};if(window.mobileApp&&window.mobileApp.postMessage){window.mobileApp.postMessage(m)}else{window.AndroidInterface.postMessage(JSON.stringify(m))}}`
    + `try{var r=await fetch(${JSON.stringify(url)},{credentials:'include'${probe ? ",headers:{Range:'bytes=0-0'}" : ''}});var t=r.headers.get('content-type')||'';var d=null;`
    + `if(${!probe}&&r.ok){var b=await r.blob();d=await new Promise(function(res){var f=new FileReader();f.onload=function(){res(f.result)};f.readAsDataURL(b)})}`
    + `post({synReq:${id},status:r.status,type:t,data:d})}catch(e){post({synReq:${id},status:0,error:String(e)})}})()`;
  await InAppBrowser.executeScript({ code });
  try { return await result; } finally {
    if (!session.pending.size) { clearTimeout(session.idle); session.idle = setTimeout(closeSession, 4000); }
  }
}

/** Diagnostica: prova a scaricare un'immagine in tutti i modi e scrive i risultati nel registro. */
export async function diagnoseMedia(url, referer) {
  console.log(`[test] immagine: ${url}`);
  for (const [label, headers] of [['nativo, header browser', { ...IMG_HEADERS, ...(referer ? { Referer: referer } : {}) }], ['nativo, minimo', {}]]) {
    try {
      const r = native ? await CapacitorHttp.request({ url, method: 'GET', responseType: 'blob', headers, connectTimeout: 20000, readTimeout: 30000 })
        : await fetch(url).then(async (x) => ({ status: x.status, headers: { 'content-type': x.headers.get('content-type') }, data: '' }));
      console.log(`[test] ${label}: HTTP ${r.status} ${lower(r.headers)['content-type'] || ''} ${typeof r.data === 'string' ? r.data.length : ''} byte(b64)`);
    } catch (e) { console.log(`[test] ${label}: errore ${e.message}`); }
  }
  await new Promise((resolve) => {
    const img = new Image(); img.referrerPolicy = 'no-referrer';
    img.onload = () => { console.log(`[test] <img> senza referrer: OK ${img.naturalWidth}x${img.naturalHeight}`); resolve(); };
    img.onerror = () => { console.log('[test] <img> senza referrer: errore'); resolve(); };
    img.src = url; setTimeout(resolve, 15000);
  });
  if (native) {
    try { const r = await browserFetch(url, { probe: true }); console.log(`[test] browser interno: HTTP ${r.status} ${r.type} ${r.error || ''}`); }
    catch (e) { console.log(`[test] browser interno: errore ${e.message}`); }
  }
}
