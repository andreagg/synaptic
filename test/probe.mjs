// Diagnostica su un sito reale (gira in GitHub Actions, che ha accesso libero a internet).
// Salva in probe-out/: HTML grezzo (fetch), HTML renderizzato (Playwright), screenshot,
// e il risultato del motore. Uso: node test/probe.mjs <url>
import fs from 'node:fs';
import { chromium } from 'playwright';
import { load, findChapterList, findImages, findReaderPages, findNextLink, findFiles } from '../src/engine/analyze.js';

const url = process.argv[2] || 'https://onepiecepower.com/manga8/onepiece/volumi/lista-capitoli';
const out = 'probe-out';
fs.mkdirSync(out, { recursive: true });
const report = { url, steps: [] };
const log = (k, v) => { console.log(`== ${k}:`, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); report.steps.push({ k, v }); };
const save = (name, data) => fs.writeFileSync(`${out}/${name}`, data);

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

// 1) fetch semplice
for (const [name, headers] of [
  ['fetch-minimo', {}],
  ['fetch-browser', { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'it-IT,it;q=0.9' }],
]) {
  try {
    const r = await fetch(url, { headers, redirect: 'follow' });
    const html = await r.text();
    save(`${name}.html`, html);
    log(name, { status: r.status, server: r.headers.get('server'), cfRay: r.headers.get('cf-ray'), len: html.length, title: (html.match(/<title>([^<]*)/i) || [])[1] });
  } catch (e) { log(name, 'ERRORE ' + e.message); }
}

// 2) Playwright
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 412, height: 915 }, locale: 'it-IT' });
const page = await ctx.newPage();
const imgResponses = [];
page.on('response', (r) => { if (r.request().resourceType() === 'image') imgResponses.push(`${r.status()} ${r.url()}`); });
const visit = async (u, name) => {
  const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => ({ status: () => 'ERR ' + e.message }));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // attende che la verifica Cloudflare finisca (la pagina si ricarica da sola)
  for (let i = 0; i < 25; i++) {
    const t = await page.title().catch(() => '');
    if (!/Just a moment|Ci siamo quasi|Un momento|Attention/i.test(t)) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const html = await page.content();
  save(`${name}.html`, html);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  log(name, { status: resp?.status?.(), finalUrl: page.url(), title: await page.title(), len: html.length });
  return html;
};
const indexHtml = await visit(url, 'pw-indice');
const cookies = await ctx.cookies();
log('cookies', cookies.map((c) => `${c.domain} ${c.name}`));

const $ = load(indexHtml);
const list = findChapterList($, page.url());
log('motore-indice', list ? { n: list.items.length, confidence: list.confidence, pattern: list.pattern, primi: list.items.slice(0, 5), ultimi: list.items.slice(-3) } : null);
log('link-campione', $('a[href]').slice(0, 80).map((i, el) => `${$(el).text().trim().slice(0, 50)} | ${$(el).attr('href')}`).get());
log('file', findFiles($, page.url()).slice(0, 5));

if (list?.items?.length) {
  const ch = list.items.find((i) => /9\b|009/.test(i.title)) || list.items[0];
  const chHtml = await visit(ch.url, 'pw-capitolo');
  const $c = load(chHtml);
  log('motore-immagini', findImages($c, chHtml, page.url()));
  log('motore-pagine', findReaderPages(load(chHtml), page.url()).slice(0, 10));
  log('motore-next', findNextLink(load(chHtml), page.url()));
  log('immagini-scaricate-dal-browser', imgResponses.filter((u) => !/favicon|ads|doubleclick|google/.test(u)).slice(-40));
  log('script-inline-con-immagini', load(chHtml)('script:not([src])').map((i, el) => load(chHtml)(el).html()).get().filter((c) => /\.(jpe?g|png|webp)/i.test(c)).map((c) => c.slice(0, 1500)));
  const pages = findReaderPages(load(chHtml), page.url());
  const nx = findNextLink(load(chHtml), page.url());
  const p2 = pages.find((p) => p.n === 2)?.url || nx;
  if (p2) { const h2 = await visit(p2, 'pw-capitolo-p2'); log('motore-immagini-p2', findImages(load(h2), h2, page.url())); }
  log('img-campione', $c('img').slice(0, 40).map((i, el) => Object.fromEntries(Object.entries(el.attribs))).get());
  log('select-campione', $c('select').map((i, el) => $c(el).find('option').slice(0, 5).map((j, o) => `${$c(o).attr('value')} | ${$c(o).text()}`).get()).get());
  // fetch nativo del capitolo e di un'immagine, con i cookie del browser
  const cookieHeader = (await ctx.cookies(ch.url)).map((c) => `${c.name}=${c.value}`).join('; ');
  const r = await fetch(ch.url, { headers: { 'user-agent': UA, cookie: cookieHeader } }).catch((e) => ({ status: 'ERR ' + e.message }));
  log('fetch-capitolo-con-cookie', { status: r.status });
  const img = findImages($c, chHtml, page.url()).images[0];
  if (img) {
    const ri = await fetch(img, { headers: { 'user-agent': UA, referer: ch.url } }).catch((e) => ({ status: 'ERR ' + e.message }));
    log('fetch-immagine', { img, status: ri.status, type: ri.headers?.get?.('content-type') });
  }
}
await browser.close();
save('report.json', JSON.stringify(report, null, 2));
