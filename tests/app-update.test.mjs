import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Emitter } from '../core/emitter.js';
import { compareVersions, planUpdate, safePath, toBase64, toHex, startAppUpdates } from '../ui/app-update.js';

test('compareVersions', () => {
  assert.equal(compareVersions('0.12.1', '0.13.0'), -1);
  assert.equal(compareVersions('0.13.0', '0.12.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
});

test('planUpdate: newer + compatible → download; newer shell → needsApk; same/older → none', () => {
  assert.equal(planUpdate({ current: { version: '0.12.1' }, remote: { version: '0.13.0', shell: 1 }, nativeShell: 1 }), 'download');
  assert.equal(planUpdate({ current: { version: '0.12.1' }, remote: { version: '0.13.0', shell: 2 }, nativeShell: 1 }), 'needsApk');
  assert.equal(planUpdate({ current: { version: '0.13.0' }, remote: { version: '0.13.0', shell: 1 }, nativeShell: 1 }), 'none');
  assert.equal(planUpdate({ current: { version: '0.14.0' }, remote: { version: '0.13.0', shell: 1 }, nativeShell: 1 }), 'none');
  assert.equal(planUpdate({ current: { version: '0.12.1' }, remote: null, nativeShell: 1 }), 'none');
});

test('safePath only accepts plain relative paths', () => {
  for (const ok of ['index.html', 'games/ludo/index.js', 'vendor/three/build/three.module.js']) assert.ok(safePath(ok), ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', './a']) assert.ok(!safePath(bad), bad);
});

test('toHex / toBase64', () => {
  const buf = new TextEncoder().encode('board games').buffer;
  assert.equal(toBase64(buf), Buffer.from('board games').toString('base64'));
  assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), '000fff');
});

// ── the whole flow against a fake Capacitor ──

function fakeApp({ installed = '0.12.1', remote = '0.13.0', remoteShell = 1, basePath = 'public', storage = new Map(), corrupt = false, slash = '' } = {}) {
  const files = new Map(); // DATA path → base64
  const calls = [];
  let path = basePath;
  const Filesystem = {
    async readdir({ path: p }) {
      const names = new Set([...files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split('/')[0]));
      if (!names.size) throw new Error('missing');
      return { files: [...names].map((name) => ({ name })) };
    },
    async rmdir({ path: p }) { for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k); },
    async writeFile({ path: p, data }) { files.set(p, data); },
    async rename({ from, to }) {
      for (const [k, v] of [...files]) if (k.startsWith(`${from}/`)) { files.delete(k); files.set(to + k.slice(from.length), v); }
    },
    // slash: '/' = the phone reports folder paths with a trailing slash
    async getUri({ path: p }) { return { uri: `file:///data/user/0/app/files/${p}${slash}` }; },
  };
  const WebView = {
    async getServerBasePath() { return { path: path === 'public' ? path : `${path.replace(/\/+$/, '')}${slash}` }; },
    async setServerBasePath({ path: p }) { calls.push(['set', p]); path = p; },
    async persistServerBasePath() { calls.push(['persist', path]); },
  };
  const site = {
    'version.json': JSON.stringify({ version: remote, shell: remoteShell }),
    'index.html': '<!doctype html><title>new</title>',
    'games/ludo/index.js': 'export const x = 1;',
  };
  const manifest = {
    version: remote,
    shell: remoteShell,
    files: ['index.html', 'games/ludo/index.js', 'version.json'].map((p) => ({
      path: p, size: site[p].length, sha256: createHash('sha256').update(corrupt && p === 'index.html' ? 'other' : site[p]).digest('hex'),
    })),
  };
  const URL_ = 'https://example.test/app/';
  const fetch = async (url) => {
    const body = url === './version.json' ? JSON.stringify({ version: installed, shell: 1 })
      : url === `${URL_}files.json` ? JSON.stringify(manifest)
      : url.startsWith(URL_) ? site[decodeURIComponent(url.slice(URL_.length))] : undefined;
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(body), arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  return { files, calls, Filesystem, WebView, fetch, storage, URL_ };
}

async function run(app, phase = 'menu') {
  const prev = { Capacitor: globalThis.Capacitor, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { Filesystem: app.Filesystem, WebView: app.WebView } };
  globalThis.fetch = app.fetch;
  globalThis.localStorage = { getItem: (k) => app.storage.get(k) ?? null, setItem: (k, v) => app.storage.set(k, String(v)) };
  const session = new Emitter();
  session.phase = phase;
  const said = [];
  const versions = [];
  try {
    startAppUpdates({ session, updateUrl: app.URL_, say: (t) => said.push(t), onVersion: (v) => versions.push(v) });
    await new Promise((r) => setTimeout(r, 1500)); // download + the short pause before switching
    return { session, said, versions };
  } finally {
    Object.assign(globalThis, prev);
  }
}

test('app update: downloads, verifies and switches to the new version on the menu', async () => {
  const app = fakeApp();
  const { said, versions } = await run(app);
  assert.deepEqual(versions, ['0.12.1']);
  assert.equal(app.storage.get('boardgames.app.shell'), '1');
  assert.equal(app.files.size, 3);
  assert.ok(app.files.has('bundles/0.13.0/games/ludo/index.js'));
  assert.deepEqual(app.calls, [['set', '/data/user/0/app/files/bundles/0.13.0']]);
  assert.equal(app.storage.get('boardgames.app.triedVersion'), '0.13.0');
  assert.ok(said.some((t) => t.includes('0.13.0')));
});

test('app update: the new version persists itself once it starts, and old bundles are removed', async () => {
  const storage = new Map([['boardgames.app.shell', '1'], ['boardgames.app.triedVersion', '0.13.0']]);
  const app = fakeApp({ installed: '0.13.0', remote: '0.13.0', basePath: '/data/user/0/app/files/bundles/0.13.0', storage });
  app.files.set('bundles/0.13.0/index.html', 'x');
  app.files.set('bundles/0.12.5/index.html', 'old');
  app.files.set('bundles/tmp-0.14.0/index.html', 'half');
  await run(app);
  assert.deepEqual(app.calls, [['persist', '/data/user/0/app/files/bundles/0.13.0']]);
  assert.equal(storage.get('boardgames.app.okVersion'), '0.13.0');
  assert.deepEqual([...app.files.keys()], ['bundles/0.13.0/index.html']);
});

test('app update: waits for the game select screen before switching', async () => {
  const app = fakeApp();
  const { session } = await run(app, 'playing');
  assert.deepEqual(app.calls, []);
  session.phase = 'menu';
  session.emit('phase', 'menu');
  await new Promise((r) => setTimeout(r, 1400));
  assert.deepEqual(app.calls.map((c) => c[0]), ['set']);
});

test('app update: a checksum mismatch means nothing is switched', async () => {
  const app = fakeApp({ corrupt: true });
  await run(app);
  assert.deepEqual(app.calls, []);
  assert.ok(![...app.files.keys()].some((k) => k.startsWith('bundles/0.13.0/')));
});

test('app update: needs a newer APK → no download, just a message', async () => {
  const app = fakeApp({ remoteShell: 2 });
  const { said } = await run(app);
  assert.equal(app.files.size, 0);
  assert.deepEqual(app.calls, []);
  assert.ok(said.some((t) => t.includes('APK')));
});

test('app update: a version that never started is not tried again', async () => {
  const storage = new Map([['boardgames.app.triedVersion', '0.13.0']]);
  const app = fakeApp({ storage });
  const { said } = await run(app);
  assert.deepEqual(app.calls, []);
  assert.ok(said.some((t) => t.includes("didn't start")));
});

test('app update: does nothing outside the app', async () => {
  const prev = globalThis.Capacitor;
  delete globalThis.Capacitor;
  try {
    assert.equal(startAppUpdates({ session: new Emitter(), updateUrl: 'https://example.test/app/' }), null);
  } finally { globalThis.Capacitor = prev; }
});

// Bug seen on a real phone (v0.14.0): with a trailing slash in the folder path, the running
// version deleted its own folder at start. The menu still worked (already loaded), but starting a
// game failed, and after a restart the app fell back to the APK's version.
test('app update: a trailing slash in folder paths never deletes the running version', async () => {
  // 1. download + switch with paths ending in "/"
  const storage = new Map();
  const app = fakeApp({ slash: '/', storage });
  await run(app);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0][1], '/data/user/0/app/files/bundles/0.13.0', 'stored without the trailing slash');
  assert.equal(storage.get('boardgames.app.triedVersion'), '0.13.0');
  // 2. the new version starts: it must keep its own folder and persist it
  const files = app.files;
  const next = fakeApp({ installed: '0.13.0', remote: '0.13.0', basePath: '/data/user/0/app/files/bundles/0.13.0', slash: '/', storage });
  for (const [k, v] of files) next.files.set(k, v);
  next.files.set('bundles/0.12.9/index.html', 'old');
  await run(next);
  assert.ok(next.files.has('bundles/0.13.0/index.html'), 'the running version keeps its files');
  assert.ok(!next.files.has('bundles/0.12.9/index.html'), 'older downloads are still removed');
  assert.deepEqual(next.calls.map((c) => c[0]), ['persist']);
  assert.equal(storage.get('boardgames.app.okVersion'), '0.13.0');
});

test('app update: cleanup only ever touches downloaded version folders', async () => {
  const app = fakeApp({ installed: '0.13.0', remote: '0.13.0', basePath: '/data/user/0/app/files/bundles/0.13.0' });
  app.files.set('bundles/0.13.0/index.html', 'x');
  app.files.set('bundles/notes/keep.txt', 'not ours');
  app.files.set('bundles/tmp-0.14.0/index.html', 'half');
  await run(app);
  assert.ok(app.files.has('bundles/0.13.0/index.html'));
  assert.ok(app.files.has('bundles/notes/keep.txt'));
  assert.ok(!app.files.has('bundles/tmp-0.14.0/index.html'));
});
