// Twitch Board Games companion app: `node app/companion.mjs [port] [--no-panel]` (or `npm start`).
//
// This small launcher runs app/server.mjs and starts it again when it asks to restart
// (after installing an update or changing settings), so the window can stay open all stream.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESTART_CODE = 75;
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`\nThe companion app needs Node.js 22 or newer (you have ${process.version}).`);
  console.error('Install the current LTS from https://nodejs.org, then open a new terminal and try again.\n');
  process.exit(1);
}

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
let restarts = 0;

function run(restarted) {
  const child = fork(server, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, ...(restarted ? { BOARDGAMES_RESTARTED: '1' } : {}) },
  });
  const forward = (sig) => child.kill(sig);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.on('exit', (code) => {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    if (code === RESTART_CODE && restarts++ < 20) {
      console.log('\n[companion] restarting…\n');
      run(true);
    } else {
      process.exit(code ?? 0);
    }
  });
}

run(false);
