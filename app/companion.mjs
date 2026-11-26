// Stream Board Games companion app: `node app/companion.mjs [port] [--no-panel]` (or `npm start`),
// or StreamBoardGames.exe on Windows (see app/sea-main.mjs).
//
// This small launcher runs app/server.mjs and starts it again when it asks to restart
// (after installing an update or changing settings), so the window can stay open all stream.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART_CODE = 75;
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

// exe: true when running as StreamBoardGames.exe. The exe starts itself again as the server
// (BOARDGAMES_ROLE=server), and keeps its window open on errors so the message can be read.
export function runCompanion({ args = process.argv.slice(2), exe = false } = {}) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    console.error(`\nThe companion app needs Node.js 22 or newer (you have ${process.version}).`);
    console.error('Install the current LTS from https://nodejs.org, then open a new terminal and try again.\n');
    process.exit(1);
  }

  let restarts = 0;
  let child = null;
  // Ctrl+C reaches the server directly (same console); it saves and exits, then we follow.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child?.kill('SIGTERM'));

  const run = (restarted) => {
    const env = { ...process.env, BOARDGAMES_ROLE: 'server', ...(restarted ? { BOARDGAMES_RESTARTED: '1' } : {}) };
    child = spawn(process.execPath, exe ? args : [SERVER, ...args], { stdio: 'inherit', env });
    child.on('exit', (code, signal) => {
      if (code === RESTART_CODE && restarts++ < 20) {
        console.log('\n[companion] restarting…\n');
        run(true);
      } else if (exe && code) {
        waitForEnter(code);
      } else {
        process.exit(code ?? (signal ? 0 : 1));
      }
    });
  };
  run(false);
}

function waitForEnter(code) {
  console.log('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCompanion();
