// One place for everything the overlay saves (viewer stats, trivia cache and categories).
//
// By default this is the browser's localStorage. When the overlay runs from the companion app
// (?bridge=node), useCompanionStorage() switches to a file on the streamer's PC instead:
// all keys are loaded once at startup, reads stay synchronous, and writes go to the app.

let backend = safeLocalStorage();

export const storage = {
  getItem: (key) => backend?.getItem(key) ?? null,
  setItem: (key, value) => backend?.setItem(key, String(value)),
  removeItem: (key) => backend?.removeItem?.(key),
};

const HEADERS = { 'Content-Type': 'application/json', 'X-BoardGames': '1' };

// Loads the companion's saved keys. Anything this browser has in localStorage that the app
// doesn't have yet is copied over once, so stats from before the app aren't lost.
export async function useCompanionStorage(base = '', { fetch = globalThis.fetch.bind(globalThis), local = safeLocalStorage() } = {}) {
  const res = await fetch(`${base}/api/kv`, { headers: HEADERS });
  if (!res.ok) throw new Error(`companion storage: HTTP ${res.status}`);
  const values = new Map(Object.entries(await res.json()));

  const put = (key, value) => fetch(`${base}/api/kv/${encodeURIComponent(key)}`, {
    method: value === null ? 'DELETE' : 'PUT', headers: HEADERS, body: value === null ? undefined : JSON.stringify({ value }),
  }).catch((err) => console.warn('[storage] could not save to the companion app', key, err));

  const migrate = [];
  try {
    for (let i = 0; i < (local?.length ?? 0); i++) {
      const key = local.key(i);
      if (key?.startsWith('boardgames.') && !values.has(key)) migrate.push(key);
    }
  } catch { /* storage blocked */ }
  for (const key of migrate) {
    values.set(key, local.getItem(key));
    put(key, values.get(key));
  }

  backend = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, value); put(key, value); },
    removeItem: (key) => { values.delete(key); put(key, null); },
  };
  return { migrated: migrate };
}

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
