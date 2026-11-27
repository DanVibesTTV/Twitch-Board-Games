// Builds mobile/www — the web files Capacitor packs into the Android app.
// Same files as the GitHub Pages overlay, plus Three.js bundled locally (works offline,
// starts fast) and the local bridge as the default, so the app opens straight into tap-to-play.
//
//   node build-www.mjs                 (Three.js from mobile/node_modules/three)
//   THREE_DIR=/path/to/three node build-www.mjs

import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'www');
const threeDir = resolve(process.env.THREE_DIR ?? join(here, 'node_modules', 'three'));

// Everything the overlay loads at runtime (keep in sync with .github/workflows/pages.yml).
const SITE = ['index.html', 'main.js', 'core', 'bridges', 'renderer', 'ui', 'games', 'sounds'];
// Only the Three.js files the games import.
const THREE_FILES = ['build/three.module.js', 'examples/jsm/geometries/RoundedBoxGeometry.js'];

await access(join(threeDir, THREE_FILES[0])).catch(() => {
  throw new Error(`Three.js not found in ${threeDir} — run "npm install" in mobile/ or set THREE_DIR.`);
});

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const item of SITE) await cp(join(root, item), join(out, item), { recursive: true });
for (const file of THREE_FILES) await cp(join(threeDir, file), join(out, 'vendor', 'three', file), { recursive: true });

let html = await readFile(join(out, 'index.html'), 'utf8');
html = html
  .replace(/"three":\s*"[^"]+"/, '"three": "./vendor/three/build/three.module.js"')
  .replace(/"three\/addons\/":\s*"[^"]+"/, '"three/addons/": "./vendor/three/examples/jsm/"')
  .replace('<title>', '<meta name="boardgames-bridge" content="local">\n  <title>');
if (html.includes('cdn.jsdelivr.net') || !html.includes('boardgames-bridge')) throw new Error('index.html changed — update build-www.mjs');
await writeFile(join(out, 'index.html'), html);

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(out, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`mobile/www built (v${version})`);
