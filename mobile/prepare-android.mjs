// Adjusts the Android project that "npx cap add android" generates:
//   - landscape only (the boards are 16:9) and a resizing window for the on-screen keyboard
//   - app version from the root package.json (versionCode grows with every release, so a newer
//     APK installs over an older one)
//   - the Stream Board Games icon instead of Capacitor's placeholder
// Safe to run more than once.

import { readFile, writeFile, copyFile, readdir, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const app = join(here, 'android', 'app');
const exists = (p) => access(p).then(() => true, () => false);

if (!(await exists(app))) throw new Error('mobile/android not found — run "npx cap add android" first.');

// 1. AndroidManifest: orientation + keyboard behaviour on the main activity
const manifestPath = join(app, 'src', 'main', 'AndroidManifest.xml');
let manifest = await readFile(manifestPath, 'utf8');
const setAttr = (xml, name, value) => {
  const tag = /<activity\b[^>]*>/.exec(xml);
  if (!tag) throw new Error('No <activity> in AndroidManifest.xml');
  let t = tag[0];
  const re = new RegExp(`android:${name}="[^"]*"`);
  t = re.test(t) ? t.replace(re, `android:${name}="${value}"`) : t.replace('<activity', `<activity android:${name}="${value}"`);
  return xml.replace(tag[0], t);
};
manifest = setAttr(manifest, 'screenOrientation', 'sensorLandscape');
manifest = setAttr(manifest, 'windowSoftInputMode', 'adjustResize');
await writeFile(manifestPath, manifest);

// 2. Version: 0.12.1 → versionName "0.12.1", versionCode 12001 (major * 1,000,000 + minor * 1,000 + patch)
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
const versionCode = major * 1_000_000 + minor * 1_000 + patch;
const gradlePath = join(app, 'build.gradle');
let gradle = await readFile(gradlePath, 'utf8');
if (/versionCode\s+\d+/.test(gradle) && /versionName\s+"[^"]*"/.test(gradle)) {
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
  await writeFile(gradlePath, gradle);
} else {
  console.warn('[prepare-android] versionCode/versionName not found in app/build.gradle — left unchanged');
}

// 3. Launcher icon: plain PNG icons in every density (the adaptive-icon XML is removed so Android uses them)
const res = join(app, 'src', 'main', 'res');
const icon = join(root, 'app', 'panel', 'icon.png');
await rm(join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
for (const dir of await readdir(res)) {
  if (!dir.startsWith('mipmap-')) continue;
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) await copyFile(icon, join(res, dir, name));
}

console.log(`[prepare-android] landscape, keyboard resize, version ${version} (${versionCode}), icon`);
