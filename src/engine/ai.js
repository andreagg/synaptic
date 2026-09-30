// Fallback AI (Claude) per le pagine che le euristiche non riescono a interpretare.
// L'AI non si limita a estrarre i dati: restituisce anche delle "regole" (regex sugli URL)
// che vengono salvate sul libro, così i controlli successivi non richiedono altre chiamate.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

export function aiAvailable() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client = null;
const getClient = () => (client ??= new Anthropic());

const PageAnalysis = z.object({
  pageType: z.enum(['index', 'reader', 'files', 'article', 'unknown']),
  title: z.string(),
  chapterLinkPattern: z.string(),
  chapters: z.array(z.object({ title: z.string(), url: z.string(), number: z.number().nullable() })),
  imagePattern: z.string(),
  imageUrls: z.array(z.string()),
  files: z.array(z.object({ title: z.string(), url: z.string() })),
  nextPageUrl: z.string(),
  notes: z.string(),
});

const SYSTEM = `Sei il modulo di analisi di un'app che trasforma siti web in una libreria digitale (manga, fumetti, PDF, libri, articoli).
Ricevi il riassunto di una pagina: metadati, elenco link ("testo | url"), immagini candidate e un estratto del testo.
Classifica la pagina:
- "index": elenca capitoli/volumi/numeri da leggere. Riporta i link dei capitoli in "chapters" in ordine di lettura (dal primo all'ultimo) e una regex JavaScript in "chapterLinkPattern" che riconosca SOLO gli URL dei capitoli.
- "reader": mostra le pagine di un capitolo come immagini. Riporta in "imageUrls" solo le immagini del contenuto in ordine di lettura (niente loghi, banner, pubblicità, miniature) e una regex in "imagePattern" che le riconosca. Se il lettore mostra una pagina per volta, metti in "nextPageUrl" l'URL della pagina successiva dello stesso capitolo.
- "files": offre documenti scaricabili (PDF, CBZ, EPUB...). Riportali in "files".
- "article": il contenuto è testo.
Usa solo URL presenti nell'input. Per i campi non pertinenti usa stringa vuota o array vuoto.`;

/** Chiede a Claude di interpretare una pagina. `summary` viene da summarizeForAI(). */
export async function analyzeWithAI(summary, hint = '') {
  if (!aiAvailable()) throw new Error('AI non configurata: imposta ANTHROPIC_API_KEY');
  const input = [
    `URL: ${summary.url}`,
    `Titolo: ${summary.title}`,
    summary.description ? `Descrizione: ${summary.description}` : '',
    hint ? `Contesto: ${hint}` : '',
    `\nLINK (${summary.links.length}):\n${summary.links.join('\n')}`,
    `\nIMMAGINI (${summary.images.length}):\n${summary.images.join('\n')}`,
    `\nTESTO:\n${summary.text}`,
  ].filter(Boolean).join('\n');

  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low', format: zodOutputFormat(PageAnalysis) },
    system: SYSTEM,
    messages: [{ role: 'user', content: input }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Analisi AI rifiutata');
  if (!response.parsed_output) throw new Error('Risposta AI non valida');
  const out = response.parsed_output;
  // difesa: accettiamo solo URL che erano davvero nella pagina
  const known = new Set([...summary.links.map((l) => l.split(' | ').pop()), ...summary.images]);
  out.chapters = out.chapters.filter((c) => known.has(c.url));
  out.imageUrls = out.imageUrls.filter((u) => known.has(u));
  out.files = out.files.filter((f) => known.has(f.url));
  if (out.nextPageUrl && !known.has(out.nextPageUrl)) out.nextPageUrl = '';
  for (const k of ['chapterLinkPattern', 'imagePattern']) {
    try { if (out[k]) new RegExp(out[k]); } catch { out[k] = ''; }
  }
  return out;
}
