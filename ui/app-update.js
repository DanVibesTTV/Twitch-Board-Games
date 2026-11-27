// Over-the-air updates for the Android app: new games and fixes without installing a new APK.
//
// GitHub Pages publishes the app's web files under /app/ (see .github/workflows/pages.yml):
//   version.json  { version, shell }                       shell = native shell the files need
//   files.json    { version, shell, files: [{ path, size, sha256 }] }
// The app compares versions, downloads every file into its own storage (bundles/<version>/),
// checks each SHA-256, and then points the WebView at that folder (Capacitor's
// WebView.setServerBasePath). That happens only on the game select screen, never in the middle
// of a game.
//
// Safety: the new folder is only made permanent (persistServerBasePath) by the new version itself,
// once it has started. If it fails to start, closing and reopening the app brings back the
// previous files, and that version isn't tried again automatically.
//
// "shell" is a number in mobile/package.json, raised whenever the native side changes (a new
// Capacitor plugin, permissions, …). Files that need a newer shell than the installed APK has
// are not applied; the player is told to install the new APK instead. Installing a new APK
// makes Capacitor serve its built-in files again.

// ── pure helpers (unit-tested in tests/app-update.test.mjs) ──

// -1, 0 or 1 for "0.12.1" vs "0.13.0".
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// What to do with a remote version: 'none' | 'needsApk' | 'download'.
export function planUpdate({ current, remote, nativeShell }) {
  if (!remote?.version || compareVersions(remote.version, current?.version ?? '0') <= 0) return 'none';
  if ((remote.shell ?? 1) > (nativeShell ?? 0)) return 'needsApk';
  return 'download';
}

// A manifest entry is only accepted as a plain relative path inside the bundle.
export function safePath(path) {
  const p = String(path ?? '');
  return p.length > 0 && p.length < 300 && !p.startsWith('/') && !p.includes('\\')
    && !p.split('/').some((part) => part === '' || part === '.' || part === '..');
}

// "…/files/bundles/0.14.0/" → "…/files/bundles/0.14.0" (Android may report folders with a slash at
// the end; with one, the last path segment would be empty).
export function trimPath(path) { return String(path ?? '').replace(/\/+$/, ''); }

// The downloaded version a WebView path points at ("0.14.0"), or null for the APK's own files.
export function bundleOf(path) {
  const m = /\/bundles\/([^/]+)$/.exec(trimPath(path));
  return m ? decodeURIComponent(m[1]) : null;
}

// Only folders the updater made itself are ever deleted: "0.14.0" or "tmp-0.14.0".
const OURS = /^(tmp-)?\d+(\.\d+){1,3}$/;

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ── the app side (runs only inside the Android app) ──

const SHELL_KEY = 'boardgames.app.shell';
const TRIED_KEY = 'boardgames.app.triedVersion'; // last version switched to
const OK_KEY = 'boardgames.app.okVersion';       // last downloaded version that started fine
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } },
};
const CHECK_EVERY_MS = 30 * 60 * 1000;
const BUNDLES = 'bundles';

function plugins() {
  const cap = globalThis.Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const get = (name) => cap.Plugins?.[name] ?? cap.registerPlugin?.(name);
  const Filesystem = get('Filesystem');
  const WebView = get('WebView');
  return Filesystem && WebView ? { Filesystem, WebView } : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// session: to wait for the game select screen; say(text): a toast; onVersion(v): shown in the HUD.
export function startAppUpdates({ session, say = () => {}, onVersion = () => {}, updateUrl }) {
  const p = plugins();
  if (!p || !updateUrl) return null;
  const { Filesystem, WebView } = p;
  const base = updateUrl.endsWith('/') ? updateUrl : `${updateUrl}/`;
  let current = null;
  let lastCheck = 0;
  let busy = false;
  let readyPath = null;

  // Switch only on the game select screen, and not while in a WiFi game (a reload would drop it).
  const free = () => session.phase === 'menu' && !session.lanHost && !session.follower;
  const whenOnMenu = (fn) => {
    if (free()) return fn();
    const off = session.on('phase', () => { if (free()) { off?.(); fn(); } });
  };

  async function init() {
    current = await fetchJson('./version.json');
    onVersion(current.version);
    const { path } = await WebView.getServerBasePath().catch(() => ({ path: '' }));
    const running = bundleOf(path);       // e.g. "0.14.0" when running a download
    const fromBundle = running !== null || String(path ?? '').includes(`/${BUNDLES}/`);
    if (fromBundle) {
      // A downloaded version that got this far works: keep using it after restarts.
      store.set(OK_KEY, current.version);
      await WebView.persistServerBasePath().catch((err) => console.warn('[app-update] persist failed', err));
    } else {
      // Running the files built into the APK: remember which native shell this APK is.
      store.set(SHELL_KEY, current.shell ?? 1);
    }
    // Running a download whose folder we can't name: delete nothing rather than risk our own files.
    if (fromBundle && !running) return;
    await cleanup(running);
  }

  // Deletes downloaded bundles except the one in use (and half-finished downloads).
  async function cleanup(keep) {
    try {
      const { files } = await Filesystem.readdir({ path: BUNDLES, directory: 'DATA' });
      for (const f of files ?? []) {
        const name = typeof f === 'string' ? f : f.name;
        if (name !== keep && OURS.test(name)) await Filesystem.rmdir({ path: `${BUNDLES}/${name}`, directory: 'DATA', recursive: true }).catch(() => {});
      }
    } catch { /* no bundles folder yet */ }
  }

  async function check() {
    if (busy || readyPath) return;
    busy = true;
    lastCheck = Date.now();
    try {
      const remote = await fetchJson(`${base}version.json`);
      const nativeShell = Number(store.get(SHELL_KEY) ?? 0);
      const plan = planUpdate({ current, remote, nativeShell });
      // Switched to this version before and it never started: don't loop on a broken update.
      if (plan === 'download' && store.get(TRIED_KEY) === remote.version && store.get(OK_KEY) !== remote.version) {
        say(`Update ${remote.version} didn't start last time — staying on ${current.version}.`);
        return;
      }
      if (plan === 'needsApk') {
        say(`Version ${remote.version} is out, but it needs the newest app — install the latest APK.`);
        return;
      }
      if (plan !== 'download') return;
      readyPath = await download(remote.version);
      say(`Update ${remote.version} downloaded — it starts on the game select screen.`);
      whenOnMenu(apply);
    } catch (err) {
      console.warn('[app-update] check failed', err);
    } finally {
      busy = false;
    }
  }

  async function download(version) {
    const manifest = await fetchJson(`${base}files.json`);
    if (manifest.version !== version || !Array.isArray(manifest.files)) throw new Error('files.json does not match version.json');
    const tmp = `${BUNDLES}/tmp-${version}`;
    await Filesystem.rmdir({ path: tmp, directory: 'DATA', recursive: true }).catch(() => {});
    for (const f of manifest.files) {
      if (!safePath(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad manifest entry ${f.path}`);
      const res = await fetch(`${base}${f.path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const hash = toHex(await crypto.subtle.digest('SHA-256', buf));
      if (hash !== f.sha256) throw new Error(`${f.path}: checksum mismatch`);
      await Filesystem.writeFile({ path: `${tmp}/${f.path}`, directory: 'DATA', data: toBase64(buf), recursive: true });
    }
    const final = `${BUNDLES}/${version}`;
    await Filesystem.rmdir({ path: final, directory: 'DATA', recursive: true }).catch(() => {});
    await Filesystem.rename({ from: tmp, to: final, directory: 'DATA', toDirectory: 'DATA' });
    const { uri } = await Filesystem.getUri({ path: final, directory: 'DATA' });
    return trimPath(decodeURIComponent(uri.replace(/^file:\/\//, '')));
  }

  async function apply() {
    if (!readyPath) return;
    say('Installing the update…');
    await new Promise((r) => setTimeout(r, 1200));
    store.set(TRIED_KEY, bundleOf(readyPath) ?? '');
    await WebView.setServerBasePath({ path: readyPath }); // reloads the page from the new files
  }

  init().then(check).catch((err) => console.warn('[app-update] init failed', err));
  session.on('phase', (ph) => { if (ph === 'menu' && current && Date.now() - lastCheck > CHECK_EVERY_MS) check(); });
  return { check };
}
