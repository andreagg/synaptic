# 📚 Synaptic Library

Trasforma **qualsiasi sito** (manga, fumetti, capitoli, PDF, raccolte di documenti, articoli) in una
**libreria digitale** da leggere in un'unica web app, anche da smartphone, con **controllo automatico
degli aggiornamenti** e **AI (Claude) per i casi complicati**.

## Avvio rapido

```bash
npm install
npm start                 # http://localhost:3000
```

Poi premi **+ Aggiungi** e incolla l'URL, per esempio
`https://onepiecepower.com/manga8/onepiece/volumi/lista-capitoli`.

Per provarla senza internet c'è un sito demo con la stessa struttura (volumi → capitoli, lettore una pagina per URL, popup pubblicitari):

```bash
npm run mock              # sito demo su http://127.0.0.1:4000/manga8/onepiece/volumi/lista-capitoli
npm test                  # test del motore contro il sito demo
```

### Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `PORT` | `3000` | Porta del server |
| `DATA_DIR` | `./data` | Database SQLite e cache dei media (lettura offline) |
| `ANTHROPIC_API_KEY` | – | Abilita il fallback AI per i siti difficili |
| `AI_MODEL` | `claude-opus-5-5` | Modello usato per l'analisi |
| `REQUEST_DELAY_MS` / `PER_HOST_CONCURRENCY` | `150` / `3` | Ritmo delle richieste verso i siti |
| `CHROMIUM_PATH` | – | Chromium per i siti che generano contenuti in JavaScript (serve `npm i playwright`) |

## Come funziona il motore

```
URL ─► fetcher ─► analizzatore euristico ─┬─► indice capitoli (anche paginato)  ─► capitoli
                  (src/engine/analyze.js) ├─► file PDF/CBZ/EPUB                  ─► documenti
                                          ├─► immagini in pagina (lazy-load, JS) ─► fumetto
                                          ├─► testo principale                   ─► articolo
                                          └─► confidenza bassa ─► AI (Claude) ──► dati + regole
```

1. **Scansione della fonte** – raggruppa i link per "firma" dell'URL (stesso percorso, numeri
   generalizzati) e sceglie il gruppo che sembra un elenco di capitoli (numerazione, parole come
   *capitolo/chapter/volume*, esclusione di menu/header/footer). Segue la paginazione dell'indice.
   I capitoli sono ordinati per numero (`Capitolo 009 - Femme fatale` → 9).
2. **Risoluzione di un capitolo** (su richiesta, alla prima lettura, o con *Scarica offline*):
   - tutte le immagini nella pagina → fumetto (gestisce `data-src`, `srcset`, `<noscript>`, array nello script);
   - una immagine per pagina (menu *Pagina 01*, frecce, `?pagina=N`) → visita le pagine dello stesso
     capitolo scartando pubblicità e link ai capitoli successivi;
   - PDF/CBZ/EPUB → documento; pagina di volume che elenca capitoli → viene espansa;
   - testo lungo → articolo pulito.
3. **AI** – se le euristiche non bastano, un riassunto compatto della pagina (link, immagini, testo) viene
   inviato a Claude con output strutturato. L'AI restituisce i dati **e delle regole regex** salvate sul
   libro: i controlli successivi le riutilizzano senza nuove chiamate.
4. **Aggiornamenti** – lo scheduler controlla ogni libro con la frequenza scelta (ora/6h/giorno/settimana)
   e segna i nuovi capitoli con un badge.
5. **Media proxy con cache** – immagini e PDF passano da `/api/media` (con il `Referer` corretto contro
   i blocchi hotlink) e restano in cache su disco per la lettura offline.

## Struttura

```
server.js               API REST + file statici
src/db.js               SQLite (node:sqlite): libri e capitoli
src/fetcher.js          HTTP con retry, limiti per host, proxy, cache media, rendering JS opzionale
src/engine/analyze.js   euristiche generiche di riconoscimento
src/engine/ai.js        fallback Claude con output strutturato
src/engine/engine.js    orchestrazione: scansione, risoluzione capitoli, download offline
src/scheduler.js        controllo periodico aggiornamenti
public/                 web app mobile-first (libreria, scheda libro, lettore)
test/                   sito demo + test del motore
```

## API

`GET /api/books` · `POST /api/books {url, title?, update_hours?, use_ai?, render_js?}` ·
`GET|PATCH|DELETE /api/books/:id` · `POST /api/books/:id/scan` · `POST /api/books/:id/download` ·
`GET /api/chapters/:id` (risolve il contenuto) · `POST /api/chapters/:id/progress` · `GET /api/media?u=&ref=`

> Usa l'app solo per contenuti che hai il diritto di scaricare e leggere, rispettando i termini dei siti.
