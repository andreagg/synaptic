import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'synlib-'));
process.env.REQUEST_DELAY_MS = '0';
delete process.env.ANTHROPIC_API_KEY; // i test verificano le sole euristiche
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[k];

const { startMockSite, VOLUMES, PAGES } = await import('./mock-site.js');
const { Books, Chapters } = await import('../src/db.js');
const engine = await import('../src/engine/engine.js');

let site;
before(async () => { site = await startMockSite(4777); });
after(() => site.server.close());

const create = (p, extra = {}) => Books.create({ title: site.url + p, source_url: site.url + p, use_ai: false, ...extra });

test('indice a volumi → tutti i capitoli, in ordine', async () => {
  const b = create('/manga8/onepiece/volumi/lista-capitoli');
  await engine.scanBook(b.id);
  const chs = Chapters.list(b.id);
  const expected = Object.values(VOLUMES).flat();
  assert.deepEqual(chs.map((c) => c.sort_key), expected);
  assert.match(chs[4].title, /^Capitolo 009 - /);
  const book = Books.get(b.id);
  assert.equal(book.title, 'One Piece - Lista capitoli');
  assert.ok(book.rules.chapterPattern);
});

test('lettore una-pagina-per-URL → tutte le pagine senza pubblicità né capitolo successivo', async () => {
  const b = Books.byUrl(site.url + '/manga8/onepiece/volumi/lista-capitoli');
  const ch = Chapters.list(b.id).find((c) => c.sort_key === 9);
  const r = await engine.resolveChapterNow(ch.id);
  assert.equal(r.type, 'images');
  assert.equal(r.content.images.length, PAGES);
  r.content.images.forEach((u, i) => assert.ok(u.endsWith(`/002/009/0${i + 1}.jpg`), u));
  assert.equal(Books.get(b.id).kind, 'manga');
  assert.ok(Books.get(b.id).cover?.includes('/manga8/img/onepiece/001/001/01.jpg'));
});

test('aggiornamento: nuovi capitoli marcati come nuovi', async () => {
  const b = Books.byUrl(site.url + '/manga8/onepiece/volumi/lista-capitoli');
  site.state.extra.push(20, 21);
  const res = await engine.scanBook(b.id);
  assert.equal(res.added, 2);
  const nuovi = Chapters.list(b.id).filter((c) => c.is_new);
  assert.deepEqual(nuovi.map((c) => c.sort_key), [20, 21]);
});

test('pagine tutte nello stesso HTML con lazy-load', async () => {
  const b = create('/fumetto/storia-breve');
  await engine.scanBook(b.id);
  const [ch] = Chapters.list(b.id);
  const full = Chapters.get(ch.id);
  assert.equal(full.type, 'images');
  assert.equal(full.content.images.length, 6);
});

test('raccolta di PDF', async () => {
  const b = create('/documenti');
  await engine.scanBook(b.id);
  const chs = Chapters.list(b.id);
  assert.equal(chs.length, 3);
  assert.ok(chs.every((c) => c.type === 'pdf'));
  assert.equal(Books.get(b.id).kind, 'pdf');
});

test('download offline mette in cache tutte le immagini', async () => {
  const existing = Books.byUrl(site.url + '/fumetto/storia-breve');
  await engine.downloadBook(existing.id);
  assert.match(Books.get(existing.id).message, /offline: 6 file/);
});

test('lettore JS con pagine numerate (stile onepiecepower 2026): pagine trovate per tentativi', async () => {
  const b = create('/op2/lista-capitoli');
  await engine.scanBook(b.id);
  const chs = Chapters.list(b.id);
  assert.equal(chs.length, Object.values(VOLUMES).flat().length, 'i link .zip non devono finire tra i capitoli');
  const ch = chs.find((c) => c.sort_key === 10);
  const r = await engine.resolveChapterNow(ch.id);
  assert.equal(r.type, 'images');
  assert.equal(r.content.images.length, PAGES + 10 % 3);
  r.content.images.forEach((u, i) => assert.ok(u.endsWith(`/op2/volume002/010/0${i + 1}.jpg`), u));
});

test('schema immagini appreso: gli altri capitoli si scaricano senza aprire la pagina del lettore', async () => {
  const b = Books.byUrl(site.url + '/op2/lista-capitoli');
  const chs = Chapters.list(b.id);
  assert.equal(chs.find((c) => c.sort_key === 17).meta?.volume, '003', 'volume letto dall\'indice');
  assert.ok(Books.get(b.id).rules.imageTemplates?.length || Books.get(b.id).rules.imageTemplate, 'schema candidato appreso');
  const hits = site.state.readerHits;
  const r = await engine.resolveChapterNow(chs.find((c) => c.sort_key === 17).id);
  assert.equal(site.state.readerHits, hits, 'la pagina del capitolo non deve essere visitata');
  assert.equal(r.content.images.length, PAGES + 17 % 3);
  assert.ok(r.content.images[0].endsWith('/op2/volume003/017/01.jpg'), r.content.images[0]);
  assert.equal(Books.get(b.id).rules.imageTemplate, site.url + '/op2/volume{vol:3}/{cap:3}/{page:2}.jpg');
});

test('coda di download: i capitoli scelti diventano disponibili offline con il numero di pagine', async () => {
  const b = Books.byUrl(site.url + '/op2/lista-capitoli');
  const ids = Chapters.list(b.id).filter((c) => [11, 12].includes(c.sort_key)).map((c) => c.id);
  engine.queueDownload(b.id, ids);
  for (let i = 0; i < 50 && engine.queuedIds(b.id).length; i++) await new Promise((r) => setTimeout(r, 100));
  const chs = Chapters.list(b.id).filter((c) => ids.includes(c.id));
  assert.ok(chs.every((c) => c.meta.offline), JSON.stringify(chs.map((c) => c.meta)));
  assert.deepEqual(chs.map((c) => c.meta.pages), [PAGES + 11 % 3, PAGES + 12 % 3]);
  assert.match(Books.get(b.id).message, /2 capitoli disponibili offline/);
});
