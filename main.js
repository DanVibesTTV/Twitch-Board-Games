// Overlay entry point. Configure via URL parameters, e.g.
//   index.html?bridge=dev                              → test in a normal browser
//   index.html?bridge=irc&channel=yourname             → read-only chat, zero setup
//   index.html?bridge=lumia&token=XXXX                 → Lumia Stream
//   index.html?bridge=streamerbot&port=8080            → Streamer.bot
//   http://127.0.0.1:8765/?bridge=node                 → companion app (node app/companion.mjs)
//   index.html?bridge=local                            → play on this device with taps (the Android app's default)
// Optional: game=ludo (skip the browser), mode=duel (with game=), turn=30, lobby=45, vote=15, bots=0,
//           predictions=0, prefix=!, after=lobby (rematch instead of game select), bg=dark | bg=transparent | bg=<hex color, e.g. 102030> (background; preview=1 = dark), fps=60,
//           volume=0.8 (0–1), mute=1, stats=0 (no viewer stats), touch=1 (tap to play; on by default with bridge=local)

import { createBridge } from './bridges/index.js';
import { loadRegistry } from './core/registry.js';
import { Session } from './core/session.js';
import { StatsStore } from './core/stats.js';
import { useCompanionStorage } from './core/storage.js';
import { Stage } from './renderer/stage.js';
import { Sfx } from './renderer/audio.js';
import { createView } from './renderer/view.js';
import { Hud, mountDevConsole } from './ui/hud.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const bool = (k, d) => (q.has(k) ? !['0', 'false', 'no'].includes(q.get(k)) : d);

// The Android app's copy of index.html carries <meta name="boardgames-bridge" content="local">.
const defaultBridge = document.querySelector('meta[name="boardgames-bridge"]')?.content || 'dev';

async function main() {
  const bridgeKind = q.get('bridge') ?? defaultBridge;
  const local = bridgeKind === 'local';
  const touch = bool('touch', local);
  if (touch) document.body.classList.add('touch');
  applyBackground(q.get('bg') ?? (bridgeKind === 'dev' || local || bool('preview', false) ? 'dark' : 'transparent'));

  const bridge = createBridge(bridgeKind, {
    channel: q.get('channel'),
    token: q.get('token'),
    host: q.get('host') ?? undefined,
    port: q.has('port') ? Number(q.get('port')) : undefined,
    secure: bool('secure', false),
    playerName: q.get('name'),
  });

  // With the companion app, stats and trivia settings live in a file on the PC.
  if (bridgeKind === 'node') {
    try { await useCompanionStorage(); } catch (err) { console.warn('[storage] companion storage unavailable, using the browser', err); }
  }

  const registry = await loadRegistry();
  // Touch layout: the stage ends where the side panel starts (see hud.css), so no sideways board shift.
  const stage = new Stage(document.getElementById('stage'), { fpsCap: num('fps', 60), panelOffsets: !touch });
  stage.sfx = new Sfx({ volume: num('volume', 0.8), muted: bool('mute', false) });
  stage.sfx.loadOverrides();
  const config = {
    prefix: q.get('prefix') ?? '!',
    // Playing alone on a phone: more time per move, and no bot taking over the seat.
    turnSeconds: num('turn', local ? 90 : 30),
    ...(local ? { afkLimit: Infinity } : {}),
    lobbySeconds: num('lobby', 45),
    voteSeconds: num('vote', 15),
    fillBots: bool('bots', true),
    predictions: bool('predictions', !local),
    afterGame: q.get('after') ?? 'menu',
  };
  const stats = bool('stats', true) ? new StatsStore() : null;
  const session = new Session({ bridge, registry, view: createView(stage), config, stats });
  const send = (text) => (bridge.send ? bridge.send(text) : bridge.inject?.(text));
  new Hud(document.getElementById('hud'), {
    session, bridge, registry, prefix: config.prefix,
    touch: touch ? { send } : null,
  });
  // Tapping a piece on the board = the same "!n" as tapping the option in the side panel.
  // The Session ignores it when it isn't this player's turn.
  if (touch) stage.enableTap((option) => send(`${config.prefix}${option + 1}`));
  if (bridgeKind === 'dev') mountDevConsole(document.body, bridge);

  // After the companion app installed an update, reload into the new version once
  // nothing is being played (right away on the game select screen).
  bridge.on('appUpdated', () => {
    const reload = () => location.reload();
    if (session.phase === 'menu') reload();
    else session.on('phase', (p) => p === 'menu' && reload());
  });

  await bridge.connect();
  if (q.get('game')) session.openLobby(q.get('game'), q.get('mode') || null);

  // handy for debugging from the browser console
  Object.assign(window, { session, bridge, stage });
}

// Transparent for OBS by default; "dark" is the soft dark gradient, a hex colour gives a solid background.
function applyBackground(bg) {
  const value = String(bg).trim().replace(/^#/, '');
  if (value === 'dark' || value === '1') document.body.classList.add('preview');
  else if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) document.body.style.background = `#${value}`;
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div class="fatal card">Board games overlay failed to start:<br><code>${String(err.message ?? err)}</code></div>`);
});
