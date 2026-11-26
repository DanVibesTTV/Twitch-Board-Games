// Builds the Windows download: StreamBoardGames.exe plus the program files, zipped.
//
//   node tools/build-exe.mjs [--skip-exe]
//
// Output: dist/StreamBoardGames/ and dist/StreamBoardGames-v<version>-windows-x64.zip
//
// The exe is a Node.js single executable application (https://nodejs.org/api/single-executable-applications.html):
// a copy of node.exe with app/sea-entry.cjs embedded. That script loads app/sea-main.mjs from the files
// next to the exe, so the in-app updater can keep updating everything except Node.js itself.
//
// Needs Node.js 25.5+ (for --build-sea), on Windows for a Windows exe. The icon and version info are set
// with rcedit (via npx) on Windows. --skip-exe only stages the files and builds the zip (for testing).

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { zipFolder } from './zip.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const NAME = 'StreamBoardGames';
const dist = join(root, 'dist');
const out = join(dist, NAME);
const skipExe = process.argv.includes('--skip-exe');
const win = process.platform === 'win32';

// What streamers get. Developer-only files (tests, CI) are left out; updates may add them later, which is harmless.
const INCLUDE = ['index.html', 'main.js', 'package.json', 'README.md', 'app', 'bridges', 'core', 'docs', 'games', 'renderer', 'sounds', 'streamerbot', 'tools', 'ui'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of INCLUDE) {
  if (existsSync(join(root, entry))) cpSync(join(root, entry), join(out, entry), { recursive: true });
}
writeFileSync(join(out, 'README.txt'), [
  `Stream Board Games v${pkg.version}`,
  '',
  `1. Double-click ${NAME}.exe. A control panel opens in your browser.`,
  '2. Log in with Twitch there.',
  '3. In OBS, add a Browser Source with the URL from the panel (http://127.0.0.1:8765/?bridge=node).',
  '',
  'Keep the window open while you stream. Keep the exe in this folder with the other files.',
  'Updates are offered in the control panel. Your stats and login are stored in %APPDATA%\\TwitchBoardGames.',
  '',
  'More: https://github.com/DanVibesTTV/Twitch-Board-Games',
  '',
].join('\r\n'));

if (!skipExe) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 25 || (major === 25 && minor < 5)) throw new Error(`--build-sea needs Node.js 25.5 or newer (this is ${process.version})`);
  const exe = join(out, win ? `${NAME}.exe` : NAME);
  const base = join(dist, win ? 'node-base.exe' : 'node-base');
  copyFileSync(process.execPath, base);
  if (win) {
    // Icon and file details (shown in Explorer → Properties → Details), set on the plain node.exe copy
    // before the app is embedded. rcedit is installed into dist/ just for this; if it fails, the exe
    // still works, just with Node's icon.
    try {
      const tools = join(dist, 'build-tools');
      execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', tools, 'rcedit@4'], { stdio: 'inherit', shell: true });
      const mod = createRequire(join(tools, 'package.json'))('rcedit');
      const rcedit = mod.rcedit ?? mod.default ?? mod;
      await rcedit(base, {
        icon: join(root, 'app', 'icon.ico'),
        'file-version': pkg.version,
        'product-version': pkg.version,
        'version-string': {
          ProductName: 'Stream Board Games',
          FileDescription: 'Stream Board Games companion app',
          CompanyName: 'DanVibesTTV',
          OriginalFilename: `${NAME}.exe`,
          InternalName: NAME,
          LegalCopyright: 'Node.js runtime (c) OpenJS Foundation and contributors',
        },
      });
      rmSync(tools, { recursive: true, force: true });
      console.log('icon and file details set');
    } catch (err) {
      console.warn(`::warning::could not set the exe icon (${err.message}); continuing with Node's icon`);
    }
  }
  const config = join(dist, 'sea-config.json');
  writeFileSync(config, JSON.stringify({
    main: join(root, 'app', 'sea-entry.cjs'),
    output: exe,
    executable: base,
    mainFormat: 'commonjs',
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    execArgv: ['--disable-warning=ExperimentalWarning'],
  }, null, 2));
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
  rmSync(base, { force: true });
  rmSync(config, { force: true });
  console.log(`built ${exe}`);
}

const zip = join(dist, `${NAME}-v${pkg.version}-windows-x64.zip`);
const count = zipFolder(out, zip, NAME);
console.log(`zipped ${count} files → ${zip}`);
