// Entry point of StreamBoardGames.exe, loaded from disk by the small script embedded in the exe
// (app/sea-entry.cjs). Living here instead of inside the exe means the in-app updater can update it.
// No top-level await: the exe loads this file with require().

import { runCompanion } from './companion.mjs';
import { runServerCli } from './server.mjs';
import { runSessionServerCli } from './session-server.mjs';

const args = process.argv.slice(2);
// "StreamBoardGames.exe --session-server": the server viewers' phones connect to (docs/SESSION_SERVER.md).
if (args.includes('--session-server')) runSessionServerCli(args);
else if (process.env.BOARDGAMES_ROLE === 'server') runServerCli(args);
else runCompanion({ args, exe: true });
