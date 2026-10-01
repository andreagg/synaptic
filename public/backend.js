// Backend "server": l'interfaccia parla con le API REST di server.js.
// Nella app Android questo modulo viene sostituito da mobile/backend.js (motore locale).
export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

export async function mediaUrl(u, ref) {
  return `/api/media?u=${encodeURIComponent(u)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
}

export const renderPdf = null;   // il browser desktop mostra i PDF in un iframe
export const settings = null;    // la configurazione del server è nelle variabili d'ambiente
export async function init() {}
export const logs = null;
export const version = 'server';
export const mediaUrlForce = null;
export const diagnose = null;
