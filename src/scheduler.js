// Controllo periodico degli aggiornamenti: ogni minuto cerca i libri "scaduti"
// (last_checked + update_hours) e li riscansiona per trovare nuovi capitoli.
import { Books } from './db.js';
import { scanBook, isBusy } from './engine/engine.js';

export function startScheduler({ everyMs = 60_000 } = {}) {
  // se il server si era fermato durante una scansione, sblocca lo stato
  for (const b of Books.list()) if (['scanning', 'downloading'].includes(b.status)) Books.update(b.id, { status: 'idle' });
  const tick = async () => {
    for (const b of Books.due()) {
      if (isBusy(b.id)) continue;
      console.log(`[scheduler] controllo aggiornamenti: ${b.title}`);
      await scanBook(b.id).catch(() => {});
    }
  };
  const t = setInterval(tick, everyMs);
  t.unref();
  setTimeout(tick, 5000).unref();
  return () => clearInterval(t);
}
