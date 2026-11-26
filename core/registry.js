// Discovers installed game add-ons. A browser can't list folders, so
// games/index.json lists the ids; each id has games/<id>/manifest.json
// and games/<id>/index.js.

import { CORE_VERSION } from './session.js';

// What each manifest "needs" entry requires from the bridge.
const NEEDS = {
  hiddenInfo: (caps) => caps.whisper || caps.extension,
  sendChat: (caps) => caps.sendChat,
  predictions: (caps) => caps.predictions,
};

const major = (v) => String(v).split('.')[0];

export async function loadRegistry(baseUrl = new URL('../games/', import.meta.url)) {
  const base = new URL(baseUrl);
  const ids = await (await fetch(new URL('index.json', base))).json();
  const manifests = [];
  for (const id of ids) {
    try {
      const m = await (await fetch(new URL(`${id}/manifest.json`, base))).json();
      if (major(m.coreVersion) !== major(CORE_VERSION)) {
        console.warn(`[registry] ${id} targets core ${m.coreVersion}, this is ${CORE_VERSION} — skipped`);
        continue;
      }
      m.needs ??= [];
      m.thumbnailUrl = m.thumbnail ? new URL(`${id}/${m.thumbnail}`, base).href : null;
      manifests.push(m);
    } catch (err) {
      console.warn(`[registry] could not load manifest for "${id}"`, err);
    }
  }
  return createRegistry(manifests, (id) => import(new URL(`${id}/index.js`, base).href));
}

// Also used directly by tests (no fetch).
export function createRegistry(manifests, importer) {
  const cache = new Map();
  return {
    list: manifests,
    get: (id) => manifests.find((m) => m.id === id) ?? null,
    isPlayable: (m, caps) => (m.needs ?? []).every((n) => NEEDS[n]?.(caps) ?? false),
    missing: (m, caps) => (m.needs ?? []).filter((n) => !(NEEDS[n]?.(caps) ?? false)),
    load: async (id) => {
      if (!cache.has(id)) cache.set(id, importer(id));
      return cache.get(id);
    },
  };
}
