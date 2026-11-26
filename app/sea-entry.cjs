// Embedded into StreamBoardGames.exe (Node.js single executable application, see tools/build-exe.mjs).
// Keep this tiny and stable: it only changes when someone downloads a new .exe. Everything else is
// loaded from the files next to the exe, which the in-app updater keeps up to date.
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const main = path.join(path.dirname(process.execPath), 'app', 'sea-main.mjs');
process.title = 'Stream Board Games';

try {
  if (!fs.existsSync(main)) {
    throw new Error(`Can't find ${main}\n\nKeep StreamBoardGames.exe in its folder, next to the "app", "games" and other folders from the ZIP.`);
  }
  createRequire(main)(main);
} catch (err) {
  console.error(`\n${(err && err.stack) || err}\n`);
  console.error('Press Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}
