// Sito finto che imita la struttura di un sito di manga reale (onepiecepower):
// indice con volumi a fisarmonica → capitoli; lettore con una pagina per URL,
// menu "Pagina" e frecce; popup pubblicitari e menu di navigazione come rumore.
// Contiene anche una variante con pagine in un'unica pagina e una raccolta di PDF.
import http from 'node:http';

const TITLES = ['Romance Dawn', "L'uomo col cappello di paglia", 'Morgan contro Rufy', 'Il capitano Kuro',
  'Femme fatale', 'Incidente al bar', 'Fuga', 'Il Cane', 'Tesoro', 'Imprudente', 'Gong', 'Vergogna!'];
export const VOLUMES = { 1: [1, 2, 3, 4], 2: [9, 10, 11, 12], 3: [17, 18, 19] };
export const PAGES = 5;
const pad = (n, l = 3) => String(n).padStart(l, '0');

const layout = (title, body) => `<!doctype html><html><head><title>${title} - OnePiecePower</title>
<meta property="og:title" content="${title}"><link rel="stylesheet" href="/style.css"></head><body>
<header><nav><a href="/">Home</a> <a href="/manga8/">Manga</a> <a href="/anime/">Anime</a> <a href="/contatti">Contatti</a></nav>
<img src="/img/logo.png" alt="logo"></header>
<div class="popup"><img src="/ads/betvip.png" width="120" height="120"><b>Don't miss your chance</b><a href="https://ads.example/raffle">OK</a></div>
${body}
<footer><a href="/privacy">Privacy</a> <a href="/cookie">Cookie</a> <a href="/dmca">DMCA</a></footer>
<script>var ads = ["/ads/banner1.png"];</script></body></html>`;

function chapterTitle(c) { return TITLES[(c - 1) % TITLES.length]; }
function volOf(c) { return Object.entries(VOLUMES).find(([, cs]) => cs.includes(c))?.[0]; }
function allChapters() { return Object.values(VOLUMES).flat(); }

function index(extra = []) {
  const vols = { ...VOLUMES };
  const body = Object.entries(vols).map(([v, cs]) => `
    <div class="volume"><button class="vol-toggle">📘 Volume ${pad(v)} ▸</button>
      <div class="chapters" style="display:none">
        ${cs.concat(v == 3 ? extra : []).map((c) => `<a class="cap" href="/manga8/onepiece/volumi/volume${pad(v)}/capitolo-${pad(c)}">Capitolo ${pad(c)} - ${chapterTitle(c)}</a>`).join('\n')}
      </div></div>`).join('');
  return layout('One Piece - Lista capitoli', `<h1>One Piece - Lista capitoli</h1><div class="list">${body}</div>`);
}

function reader(v, c, p) {
  const base = `/manga8/onepiece/volumi/volume${pad(v)}/capitolo-${pad(c)}`;
  const list = allChapters();
  const nextC = list[list.indexOf(c) + 1];
  const next = p < PAGES ? `${base}?pagina=${p + 1}` : nextC ? `/manga8/onepiece/volumi/volume${pad(volOf(nextC))}/capitolo-${pad(nextC)}` : '#';
  const prev = p > 1 ? `${base}?pagina=${p - 1}` : '#';
  const opts = Array.from({ length: PAGES }, (_, i) => `<option value="${base}?pagina=${i + 1}"${i + 1 === p ? ' selected' : ''}>${pad(i + 1, 2)}</option>`).join('');
  return layout(`One Piece - Volume ${pad(v)} - Capitolo ${pad(c)}: ${chapterTitle(c)}`, `
    <div class="reader"><h1>One Piece - Volume ${pad(v)} - Capitolo ${pad(c)}: ${chapterTitle(c)}</h1>
    Pagina: <select onchange="location=this.value">${opts}</select>
    <a href="${prev}"><img src="/img/freccia-sx.png" width="40" height="40"></a>
    <img class="page" src="/manga8/img/onepiece/${pad(v)}/${pad(c)}/${pad(p, 2)}.jpg" alt="pagina">
    <a href="${next}"><img src="/img/freccia-dx.png" width="40" height="40"></a></div>`);
}

function pageSvg(label, sub) {
  const hue = [...label].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1150" viewBox="0 0 800 1150">
  <rect width="800" height="1150" fill="#fdfbf7"/><rect x="30" y="30" width="740" height="1090" fill="none" stroke="#111" stroke-width="6"/>
  <rect x="60" y="60" width="330" height="420" fill="hsl(${hue},40%,85%)" stroke="#111" stroke-width="4"/>
  <rect x="410" y="60" width="330" height="420" fill="hsl(${(hue + 40) % 360},40%,80%)" stroke="#111" stroke-width="4"/>
  <rect x="60" y="500" width="680" height="590" fill="hsl(${(hue + 80) % 360},35%,88%)" stroke="#111" stroke-width="4"/>
  <circle cx="400" cy="800" r="140" fill="#fff" stroke="#111" stroke-width="4"/>
  <text x="400" y="790" font-family="sans-serif" font-size="44" text-anchor="middle" font-weight="bold">${label}</text>
  <text x="400" y="845" font-family="sans-serif" font-size="30" text-anchor="middle">${sub}</text></svg>`;
}

const PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 40 100 Td (Documento demo) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);

export function startMockSite(port = 4000) {
  const state = { extra: [] }; // capitoli aggiunti "in seguito" per testare gli aggiornamenti
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' }); res.end(body); };
    let m;
    if (u.pathname === '/manga8/onepiece/volumi/lista-capitoli') return send(200, 'text/html; charset=utf-8', index(state.extra));
    if ((m = u.pathname.match(/^\/manga8\/onepiece\/volumi\/volume(\d+)\/capitolo-(\d+)$/))) {
      const v = +m[1]; const c = +m[2];
      if (!VOLUMES[v]?.includes(c) && !state.extra.includes(c)) return send(404, 'text/html', 'not found');
      return send(200, 'text/html; charset=utf-8', reader(v, c, Math.max(1, Math.min(PAGES, +(u.searchParams.get('pagina') || 1)))));
    }
    if ((m = u.pathname.match(/^\/manga8\/img\/onepiece\/(\d+)\/(\d+)\/(\d+)\.jpg$/))) {
      if (+m[3] < 1 || +m[3] > PAGES) return send(404, 'text/html', 'not found');
      return send(200, 'image/svg+xml', pageSvg(`Cap. ${+m[2]}`, `Pagina ${+m[3]}`));
    }
    // variante "onepiecepower 2026": indice /reader/NNN, lettore JS con pagine 01.jpg, 02.jpg… scoperte per tentativi
    if (u.pathname === '/op2/lista-capitoli') {
      const body = Object.entries(VOLUMES).map(([v, cs]) => `<div class="vol"><button>📘 Volume ${pad(v)}</button><div>${cs.map((c) =>
        `<a href="/op2/reader/${pad(c)}">Capitolo ${pad(c)} - ${chapterTitle(c)}</a>`).join('')}</div></div>`).join('')
        + [1170, 1171, 1172].map((c) => `<a href="http://ouo.io/qs/X?s=http://serverfile.club/download/[OPP]Cap-${c}.zip">Capitolo ${c}</a>`).join('');
      return send(200, 'text/html', layout('Lista Capitoli One Piece', body));
    }
    if ((m = u.pathname.match(/^\/op2\/reader\/(\d+)$/))) {
      const c = +m[1]; const v = volOf(c);
      return send(200, 'text/html', layout(`One Piece Capitolo ${pad(c)} ITA`, `
        <img src="/images/appOPP.png" style="max-width:50px"><img src="/images/stripeLogo.png" style="max-width:60px">
        <a href="/op2/reader/${pad(c - 1)}"><img id="arrowSxChapter" src="/images/arrowsx.png" class="frecciasxC"></a>
        <div id="page"><div class="inner"><img class="open" src="/op2/volume${pad(v)}/${pad(c)}/01.jpg"></div></div>
        <a href="/op2/reader/${pad(c + 1)}"><img id="arrowDxChapter" src="/images/arrowdx.png" class="frecciadxC"></a>
        <div style="background:url(/images/sfondo.webp)"></div><img src="/images/sfondo-dark.webp">
        <img src="/php/user/avatar/admin.png" width="30px" height="30px">
        <script>function getPageLink(p){return '/op2/volume${pad(v)}/${pad(c)}/'+(p<10?'0'+p:p)+'.jpg'}</script>`));
    }
    if ((m = u.pathname.match(/^\/op2\/volume\d+\/(\d+)\/(\d+)\.jpg$/))) {
      const c = +m[1]; const p = +m[2];
      if (p < 1 || p > PAGES + c % 3) return send(404, 'text/html', 'not found');
      return send(200, 'image/svg+xml', pageSvg(`Cap. ${c}`, `Pagina ${p}`));
    }
    // variante: tutte le pagine del capitolo in un'unica pagina HTML (lazy-load)
    if (u.pathname === '/fumetto/storia-breve') {
      const imgs = Array.from({ length: 6 }, (_, i) => `<img class="lazy" src="/img/loading.gif" data-src="/fumetto/pagine/storia-breve-${i + 1}.jpg">`).join('\n');
      return send(200, 'text/html', layout('Storia breve', `<h1>Storia breve</h1>${imgs}`));
    }
    if ((m = u.pathname.match(/^\/fumetto\/pagine\/storia-breve-(\d+)\.jpg$/))) return send(200, 'image/svg+xml', pageSvg('Storia breve', `Pagina ${m[1]}`));
    // variante: raccolta di PDF
    if (u.pathname === '/documenti') {
      const links = [1, 2, 3].map((i) => `<li><a href="/documenti/manuale-parte-${i}.pdf">Manuale - Parte ${i}</a></li>`).join('');
      return send(200, 'text/html', layout('Archivio documenti', `<h1>Archivio documenti</h1><ul>${links}</ul>`));
    }
    if (/^\/documenti\/.*\.pdf$/.test(u.pathname)) return send(200, 'application/pdf', PDF);
    if (/\.(png|gif)$/.test(u.pathname)) return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    send(404, 'text/html', 'not found');
  });
  return new Promise((r) => server.listen(port, () => r({ server, state, url: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMockSite(Number(process.env.MOCK_PORT || 4000));
  console.log(`Sito demo su ${url}/manga8/onepiece/volumi/lista-capitoli`);
}
