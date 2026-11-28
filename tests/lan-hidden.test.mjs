// Hidden-information games over WiFi: the host sends each phone only its own view. These tests
// record every message a joined phone receives during whole Texas Hold 'em tournaments and check
// that the host's hole cards never appear (unless shown at a showdown), and that the joined
// phone always sees exactly what the host's game says that seat may see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Emitter } from '../core/emitter.js';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { LocalBridge } from '../bridges/local.js';
import { LanHost, LanClient } from '../net/lan.js';
import * as holdem from '../games/holdem/logic.js';

const manifest = { ...JSON.parse(readFileSync(new URL('../games/holdem/manifest.json', import.meta.url))) };
const registry = () => createRegistry([manifest], async () => holdem);
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const fastScheduler = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); t.unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t),
};

function network(onClientMessage) {
  const host = new Emitter();
  const clients = new Map();
  let nextId = 0;
  Object.assign(host, {
    host: async () => ({ port: 47823, addresses: ['10.0.0.2'] }),
    stopHost: async () => {},
    sendTo: async (peerId, data) => { const c = clients.get(peerId); if (c) { onClientMessage(data); setImmediate(() => c.emit('message', { data })); } },
  });
  const client = () => {
    const c = new Emitter();
    const peerId = `p${++nextId}`;
    Object.assign(c, {
      connect: async () => { clients.set(peerId, c); setImmediate(() => host.emit('peer', { peerId })); },
      send: async (data) => setImmediate(() => host.emit('peerMessage', { peerId, data })),
      disconnect: async () => { clients.delete(peerId); setImmediate(() => host.emit('peerLeft', { peerId })); },
    });
    return c;
  };
  return { host, client };
}

test('Hold\'em needs a private screen: greyed out for chat-only connections, playable on phones', () => {
  const reg = registry();
  assert.equal(reg.isPlayable(manifest, { chat: true, sendChat: true, whisper: true }), false);
  assert.deepEqual(reg.missing(manifest, {}), ['a private screen (phone app or streamer dock)']);
  assert.equal(reg.isPlayable(manifest, new LocalBridge().capabilities), true);
});

test('the host screen renders only its own seat\'s view', async () => {
  const bridge = new LocalBridge({ playerName: 'Dan', playerId: 'phone-dan' });
  const shown = [];
  const view = { mount: async (_m, g) => shown.push(g), present: async (_e, g) => shown.push(g), decision: (_d, _s, g) => shown.push(g) };
  const s = new Session({ bridge, registry: registry(), view, scheduler: fastScheduler, config: { afterGame: 'menu', afkLimit: Infinity, predictions: false, botDelayMs: 1, autoSingleMoveMs: 1 } });
  bridge.send('!bg play holdem');
  await tick();
  bridge.send('!bg bots 3');
  bridge.send('!join');
  bridge.send('!bg start');
  await tick(20);
  assert.equal(s.phase, 'playing');
  assert.ok(shown.length > 0);
  const me = s.perspective;
  assert.ok(me !== null);
  for (const g of shown) {
    assert.equal(g.hidden, true, 'the renderer never gets the real game');
    assert.ok(!('deck' in g.state));
    g.state.players.forEach((p, i) => {
      if (i !== me && !s.game.state.players[i].shown) assert.ok(p.cards.every((c) => c === -1));
    });
  }
  s.toMenu();
});

test('Hold\'em over WiFi: the joined phone never receives the host\'s hole cards, and sees exactly its own view', async () => {
  const received = [];
  const net = network((data) => received.push(JSON.parse(data)));
  const hostBridge = new LocalBridge({ playerName: 'Dan', playerId: 'phone-dan' });
  const host = new Session({ bridge: hostBridge, registry: registry(), scheduler: fastScheduler, config: { afterGame: 'menu', afkLimit: Infinity, predictions: false, botDelayMs: 1, autoSingleMoveMs: 1, overSeconds: 0.01, turnSeconds: 0.01 } });
  const lanHost = new LanHost({ session: host, transport: net.host, hostName: 'Dan', appVersion: '1' });
  const guestBridge = new LocalBridge({ playerName: 'Alex', playerId: 'phone-alex' });
  const guest = new Session({ bridge: guestBridge, registry: registry(), follower: true });
  const lanClient = new LanClient({ session: guest, transport: net.client(), user: guestBridge.user, appVersion: '1' });
  await lanHost.start();
  await lanClient.join('10.0.0.2');
  await tick();

  // Track the host's real hole cards hand by hand, and compare views after every update.
  const hostCards = [];
  let mismatches = 0;
  let checks = 0;
  host.on('decision', () => {
    if (!host.game?.state) return;
    const me = host.perspective;
    const p = host.game.state.players[me];
    if (p.cards.length) hostCards.push({ hand: host.game.state.hand, cards: [...p.cards] });
  });
  let over = false;
  host.on('gameOver', () => { over = true; });

  hostBridge.send('!bg play holdem turbo');
  await tick();
  hostBridge.send('!bg bots 3'); // Dan, Alex + 1 bot
  hostBridge.send('!join');
  hostBridge.send('!bg start');
  for (let i = 0; i < 4000 && !over; i++) {
    await new Promise((r) => setTimeout(r, 2));
    if (guest.phase === 'playing' && guest.game?.state && host.game?.viewFor && host.phase === 'playing') {
      const g = host.perspective === null ? null : host.activeSeatIdx.findIndex((x) => host.seats[x]?.occupant?.user?.id === 'phone-alex');
      if (g >= 0 && guest.game.state.hand === host.game.state.hand && guest.game.state.toAct === host.game.state.toAct && guest.game.state.street === host.game.state.street) {
        checks++;
        if (JSON.stringify(guest.game.state.players[g].cards) !== JSON.stringify(host.game.viewFor(g).players[g].cards)) mismatches++;
      }
    }
  }
  await tick(20);
  assert.ok(over, 'the tournament finished');
  assert.ok(received.some((m) => m.t === 'hstart'));
  assert.ok(received.some((m) => m.t === 'hupdate'));
  assert.ok(!received.some((m) => m.t === 'start' || m.t === 'apply'), 'no replay messages (they would reveal the deck)');
  assert.ok(checks > 0);
  assert.equal(mismatches, 0, 'the guest sees its own cards exactly');

  // The leak check: the host's cards may only reach the guest when the host showed them.
  const hostSeat = (m) => m.spec?.activeSeatIdx?.findIndex((x) => m.spec.seats[x]?.occupant?.user?.id === 'phone-dan');
  let seat = null;
  for (const m of received) {
    if (m.t === 'hstart') seat = hostSeat(m);
    const view = m.t === 'hstart' ? m.spec.view : m.t === 'hupdate' ? m.view : null;
    if (view && seat !== null && seat >= 0) {
      const p = view.players[seat];
      const shownNow = view.lastResult?.hand === view.hand && view.lastResult.shown.some((x) => x.seat === seat);
      if (!shownNow) assert.ok(p.cards.every((c) => c === -1), `host's cards hidden in hand ${view.hand}`);
    }
    for (const e of m.events ?? []) if (e.cards) assert.equal(e.type, 'board');
  }
  // The host moves on to the menu right after the (very short) winner screen; on a slow
  // machine the phone may already have followed it there.
  assert.ok(['over', 'menu'].includes(guest.phase), `guest phase ${guest.phase}`);
  void hostCards;
});
