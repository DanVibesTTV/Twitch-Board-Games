// Overlay entry point. Configure via URL parameters, e.g.
//   index.html?bridge=dev                              → test in a normal browser
//   index.html?bridge=irc&channel=yourname             → read-only chat, zero setup
//   index.html?bridge=lumia&token=XXXX                 → Lumia Stream
//   index.html?bridge=streamerbot&port=8080            → Streamer.bot
// Optional: game=ludo (skip the browser), turn=30, lobby=45, vote=15, bots=0,
//           predictions=0, prefix=!, after=lobby (rematch instead of game select), preview=1 (dark background), fps=60,
//           volume=0.8 (0–1), mute=1, stats=0 (no viewer stats)

import { createBridge } from './bridges/index.js';
import { loadRegistry } from './core/registry.js';
import { Session } from './core/session.js';
import { StatsStore } from './core/stats.js';
import { Stage } from './renderer/stage.js';
import { Sfx } from './renderer/audio.js';
import { createView } from './renderer/view.js';
import { Hud, mountDevConsole } from './ui/hud.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const bool = (k, d) => (q.has(k) ? !['0', 'false', 'no'].includes(q.get(k)) : d);

async function main() {
  const bridgeKind = q.get('bridge') ?? 'dev';
  if (bridgeKind === 'dev' || bool('preview', false)) document.body.classList.add('preview');

  const bridge = createBridge(bridgeKind, {
    channel: q.get('channel'),
    token: q.get('token'),
    host: q.get('host') ?? undefined,
    port: q.has('port') ? Number(q.get('port')) : undefined,
    secure: bool('secure', false),
  });

  const registry = await loadRegistry();
  const stage = new Stage(document.getElementById('stage'), { fpsCap: num('fps', 60) });
  stage.sfx = new Sfx({ volume: num('volume', 0.8), muted: bool('mute', false) });
  stage.sfx.loadOverrides();
  const config = {
    prefix: q.get('prefix') ?? '!',
    turnSeconds: num('turn', 30),
    lobbySeconds: num('lobby', 45),
    voteSeconds: num('vote', 15),
    fillBots: bool('bots', true),
    predictions: bool('predictions', true),
    afterGame: q.get('after') ?? 'menu',
  };
  const stats = bool('stats', true) ? new StatsStore() : null;
  const session = new Session({ bridge, registry, view: createView(stage), config, stats });
  new Hud(document.getElementById('hud'), { session, bridge, registry, prefix: config.prefix });
  if (bridgeKind === 'dev') mountDevConsole(document.body, bridge);

  await bridge.connect();
  if (q.get('game')) session.openLobby(q.get('game'));

  // handy for debugging from the browser console
  Object.assign(window, { session, bridge, stage });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div class="fatal card">Board games overlay failed to start:<br><code>${String(err.message ?? err)}</code></div>`);
});
