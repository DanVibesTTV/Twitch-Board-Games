// LanHost + LanClient over an in-memory transport: lobby, auto-join, a remote tap, a full game
// in step, leaving, and refusing a phone with a different app version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Emitter } from '../core/emitter.js';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { LocalBridge } from '../bridges/local.js';
import { LanHost, LanClient } from '../net/lan.js';
import * as four from '../games/four/logic.js';
import * as ludo from '../games/ludo/logic.js';

const manifest = (id) => ({ ...JSON.parse(readFileSync(new URL(`../games/${id}/manifest.json`, import.meta.url))), needs: [] });
const registry = () => createRegistry([manifest('four'), manifest('ludo')], async (id) => ({ four, ludo }[id]));
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// Real timers, but fast (≤ 20 ms) and not keeping the test process alive.
const fastScheduler = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 20)); t.unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t),
};

// A host transport and any number of client transports wired together in memory (async delivery).
function network() {
  const host = new Emitter();
  let nextId = 0;
  const clients = new Map();
  Object.assign(host, {
    host: async () => ({ port: 47823, addresses: ['10.0.0.2'] }),
    stopHost: async () => { for (const c of clients.values()) setImmediate(() => c.emit('closed', { reason: 'host stopped' })); },
    sendTo: async (peerId, data) => { const c = clients.get(peerId); if (c) setImmediate(() => c.emit('message', { data })); },
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

function setup({ clientVersion = '1.0.0' } = {}) {
  const net = network();
  const hostBridge = new LocalBridge({ playerName: 'Dan', playerId: 'phone-dan' });
  const host = new Session({ bridge: hostBridge, registry: registry(), scheduler: fastScheduler, config: { afterGame: 'menu', afkLimit: Infinity, predictions: false, botDelayMs: 1, autoSingleMoveMs: 1, overSeconds: 0.01 } });
  const lanHost = new LanHost({ session: host, transport: net.host, hostName: 'Dan', appVersion: '1.0.0' });
  const guestBridge = new LocalBridge({ playerName: 'Alex', playerId: 'phone-alex' });
  const guest = new Session({ bridge: guestBridge, registry: registry(), follower: true });
  const changes = [];
  const lanClient = new LanClient({ session: guest, transport: net.client(), user: guestBridge.user, appVersion: clientVersion, onChange: (c) => changes.push(c) });
  return { host, hostBridge, lanHost, guest, lanClient, changes };
}

test('LAN: joining, lobby auto-join, a remote tap and a whole game in step', async () => {
  const { host, hostBridge, lanHost, guest, lanClient, changes } = setup();
  await lanHost.start();
  await lanClient.join('10.0.0.2');
  await tick();
  assert.ok(changes.some((c) => c.hostName === 'Dan'));
  assert.deepEqual(lanHost.players.map((u) => u.name), ['Alex']);

  hostBridge.send('!bg play four duel'); // two humans, no bot
  await tick();
  assert.equal(guest.phase, 'lobby');
  assert.equal(guest.manifest.id, 'four');
  // Four in a Row draws its players from everyone who joined; the guest is in that pool.
  assert.ok(host.entrants.has('phone-alex') || host.seats.some((s) => s.occupant?.user?.id === 'phone-alex'), 'the joined phone joined automatically');

  let finalHost = null;
  host.on('gameOver', () => { finalHost = JSON.stringify(host.game.state); });
  hostBridge.send('!join');
  hostBridge.send('!bg start');
  await tick(12);
  assert.equal(guest.phase, 'playing');

  // Play it out: whoever's turn it is picks the first open column (the guest by sending "!n");
  // the fast turn timer plays for anyone who is too slow.
  let guestTapped = false;
  for (let moves = 0; moves < 200 && host.phase === 'playing'; moves++) {
    const d = host.decision;
    if (!d) { await tick(); continue; }
    const occ = host.seats[host.activeSeatIdx[d.seat]].occupant;
    const pick = d.options.findIndex((o) => !o.disabled) + 1;
    if (occ.user?.id === 'phone-alex') { lanClient.send(`!${pick}`); guestTapped = true; }
    else hostBridge.send(`!${pick}`);
    await tick(10);
  }
  for (let i = 0; i < 50 && !finalHost; i++) await new Promise((r) => setTimeout(r, 10));
  await tick(20);
  assert.ok(finalHost, 'game finished');
  assert.ok(guestTapped, 'the guest got to send a move');
  assert.equal(JSON.stringify(guest.game?.state), finalHost, 'guest saw the same game');

  await lanClient.leave();
  await tick();
  assert.deepEqual(lanHost.players, []);
});

test('LAN: a phone with another app version is refused', async () => {
  const { lanHost, lanClient, changes } = setup({ clientVersion: '0.9.0' });
  await lanHost.start();
  await lanClient.join('10.0.0.2');
  await tick();
  assert.ok(changes.some((c) => /same app version/.test(c.error ?? '')));
  assert.deepEqual(lanHost.players, []);
});

test('LAN: when a joined player leaves mid-game a bot takes over, and stopping tells the phones', async () => {
  const { host, hostBridge, lanHost, lanClient, changes } = setup();
  await lanHost.start();
  await lanClient.join('10.0.0.2');
  await tick();
  hostBridge.send('!bg play ludo');
  await tick();
  hostBridge.send('!join');
  hostBridge.send('!bg start');
  await tick(12);
  assert.equal(host.phase, 'playing');
  await new Promise((r) => setTimeout(r, 5));
  await lanClient.leave();
  await tick();
  assert.ok(host.seats.some((s) => s.occupant?.type === 'bot' && s.occupant.replaced === 'Alex'));

  const { lanClient: c2, changes: ch2, lanHost: h2 } = setup();
  await h2.start();
  await c2.join('x');
  await tick();
  await h2.stop();
  await tick();
  assert.ok(ch2.some((c) => c.closed), 'phones hear that hosting stopped');
  assert.ok(changes.length > 0);
});
