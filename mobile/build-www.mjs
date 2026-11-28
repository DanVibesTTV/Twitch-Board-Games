// Builds mobile/www — the web files Capacitor packs into the Android app.
// Same files as the GitHub Pages overlay, plus Three.js bundled locally (works offline,
// starts fast) and the local bridge as the default, so the app opens straight into tap-to-play.
// Also writes version.json and files.json (path, size, SHA-256 of every file): the APK ships
// this folder, and GitHub Pages publishes the same folder under /app/ for over-the-air updates
// (ui/app-update.js).
//
//   node build-www.mjs                 (Three.js from mobile/node_modules/three)
//   THREE_DIR=/path/to/three node build-www.mjs

import { cp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'www');
const threeDir = resolve(process.env.THREE_DIR ?? join(here, 'node_modules', 'three'));

// Everything the overlay loads at runtime (keep in sync with .github/workflows/pages.yml).
const SITE = ['index.html', 'main.js', 'core', 'bridges', 'net', 'renderer', 'ui', 'games', 'sounds'];
// Only the Three.js files the games import.
const THREE_FILES = [
  'build/three.module.js',
  'examples/jsm/geometries/RoundedBoxGeometry.js',
  // Neon Chess loads its 3D models
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
];

await access(join(threeDir, THREE_FILES[0])).catch(() => {
  throw new Error(`Three.js not found in ${threeDir} — run "npm install" in mobile/ or set THREE_DIR.`);
});

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const item of SITE) await cp(join(root, item), join(out, item), { recursive: true });
for (const file of THREE_FILES) await cp(join(threeDir, file), join(out, 'vendor', 'three', file), { recursive: true });

const mobile = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const esc = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));

let html = await readFile(join(out, 'index.html'), 'utf8');
html = html
  .replace(/"three":\s*"[^"]+"/, '"three": "./vendor/three/build/three.module.js"')
  .replace(/"three\/addons\/":\s*"[^"]+"/, '"three/addons/": "./vendor/three/examples/jsm/"')
  .replace('<title>', `<meta name="boardgames-bridge" content="local">\n  <meta name="boardgames-update-url" content="${esc(mobile.updateUrl ?? '')}">\n  <title>`);
if (html.includes('cdn.jsdelivr.net') || !html.includes('boardgames-bridge')) throw new Error('index.html changed — update build-www.mjs');
await writeFile(join(out, 'index.html'), html);

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const shell = mobile.shell ?? 1;
await writeFile(join(out, 'version.json'), `${JSON.stringify({ version, shell }, null, 2)}\n`);

// files.json: every file except itself, with size and SHA-256, in a stable order.
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    const path = relative(out, full).split(sep).join('/');
    if (path === 'files.json') continue;
    const data = await readFile(full);
    files.push({ path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
}
await walk(out);
files.sort((a, b) => (a.path < b.path ? -1 : 1));
await writeFile(join(out, 'files.json'), `${JSON.stringify({ version, shell, files }, null, 1)}\n`);
const kb = Math.round(files.reduce((n, f) => n + f.size, 0) / 1024);
console.log(`mobile/www built (v${version}, shell ${shell}, ${files.length} files, ${kb} KB)`);
