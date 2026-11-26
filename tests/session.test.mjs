import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { DevBridge } from '../bridges/dev.js';
import { parsePrivmsg } from '../bridges/irc-anon.js';
import { normalizeLumiaChat } from '../bridges/lumia.js';
import { normalizeSbChat } from '../bridges/streamerbot.js';
import * as ludo from '../games/ludo/logic.js';

const manifest = JSON.parse(readFileSync(new URL('../games/ludo/manifest.json', import.meta.url)));

// Fake clock: timers run in time order, instantly.
function fakeScheduler() {
  let now = 0; let id = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => timers.delete(i),
    async runAll(limit = 100000) {
      for (let n = 0; n < limit; n++) {
        await new Promise((r) => setImmediate(r)); // let async work settle
        if (!timers.size) return n;
        const [i, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(i); now = t.at; t.fn();
      }
      throw new Error('scheduler did not settle');
    },
  };
}

function setup(config = {}) {
  const bridge = new DevBridge();
  bridge.calls = [];
  bridge.prediction = {
    create: async (...a) => bridge.calls.push(['create', ...a]),
    lock: async () => {},
    resolve: async (i) => bridge.calls.push(['resolve', i]),
    cancel: async () => bridge.calls.push(['cancel']),
  };
  bridge.sendChat = async (t) => bridge.calls.push(['chat', t]);
  const registry = createRegistry([{ ...manifest, needs: [] }], async () => ludo);
  const sched = fakeScheduler();
  const s = new Session({ bridge, registry, scheduler: sched, config: { afterGame: 'menu', ...config } });
  return { s, bridge, sched };
}

test('two humans + bots play a full game; prediction created and resolved', async () => {
  const { s, bridge, sched } = setup({ afkLimit: 1 });
  const phases = [];
  s.on('phase', (p) => phases.push(p));
  await s.openLobby('ludo');
  bridge.inject('alice: !join red');
  bridge.inject('bob: !join yellow');
  bridge.inject('bob: !join green'); // already seated → ignored
  assert.equal(s.seats.find((x) => x.id === 'red').occupant.user.name, 'alice');
  assert.equal(s.seats.find((x) => x.id === 'yellow').occupant.user.name, 'bob');
  await sched.runAll(); // lobby countdown → start → AFK → bots finish the game → menu
  assert.deepEqual(phases.slice(0, 3), ['lobby', 'playing', 'over']);
  assert.equal(s.phase, 'menu');
  const create = bridge.calls.find((c) => c[0] === 'create');
  assert.ok(create, 'prediction created');
  assert.equal(create[2].length, 4);
  assert.ok(bridge.calls.some((c) => c[0] === 'resolve'));
});

test('human input drives their turn; others are ignored', async () => {
  const { s, bridge } = setup({ fillBots: true });
  await s.openLobby('ludo');
  bridge.inject('alice: !join');
  bridge.inject('!bg start'); // streamer
  await new Promise((r) => setImmediate(r));
  assert.equal(s.phase, 'playing');
  assert.equal(s.decision.kind, 'roll');
  bridge.inject('mallory: !roll');
  assert.equal(s.decision?.kind, 'roll', 'non-player cannot roll');
  const logs = [];
  s.on('log', (l) => logs.push(l.text));
  bridge.inject('alice: !roll');
  await new Promise((r) => setImmediate(r));
  assert.match(logs[0] ?? '', /^Red rolled a [1-6]$/);
});

test('crowd seat collects votes', async () => {
  const { s, bridge, sched } = setup();
  const tallies = [];
  s.on('votes', (t) => tallies.push(t));
  await s.openLobby('ludo');
  bridge.inject('!bg crowd red');
  assert.equal(s.seats[0].occupant.type, 'crowd');
  bridge.inject('!bg start');
  await new Promise((r) => setImmediate(r));
  bridge.inject('viewer1: !roll');
  bridge.inject('viewer2: !1');
  assert.ok(tallies.length >= 1);
  s.stop();
  assert.equal(s.phase, 'menu');
  await sched.runAll();
});

test('non-mods cannot use admin commands', async () => {
  const { s, bridge } = setup();
  await s.openLobby('ludo');
  bridge.inject('viewer: !bg start');
  assert.equal(s.phase, 'lobby');
  bridge.inject('@moddy: !bg stop');
  assert.equal(s.phase, 'menu');
});

test('bridge chat normalizers', () => {
  const irc = parsePrivmsg('@badges=broadcaster/1;display-name=Streamy;mod=0;user-id=42 :streamy!streamy@streamy.tmi.twitch.tv PRIVMSG #streamy :!bg play ludo');
  assert.deepEqual(irc.user, { id: '42', login: 'streamy', name: 'Streamy', isBroadcaster: true, isMod: true });
  assert.equal(irc.text, '!bg play ludo');

  const lumia = normalizeLumiaChat({ origin: 'twitch', type: 'chat', data: { message: '!join', extraSettings: { username: 'a', displayname: 'A', userId: '7', userLevels: { mod: true } } } });
  assert.equal(lumia.user.id, '7');
  assert.equal(lumia.user.isMod, true);
  assert.equal(normalizeLumiaChat({ type: 'alert', data: {} }), null);

  const sb = normalizeSbChat({ text: '!roll', user: { id: '9', login: 'b', name: 'B', role: 3 }, broadcaster: { id: '1' } });
  assert.equal(sb.user.isMod, true);
  const sbOld = normalizeSbChat({ message: { message: '!1', userId: '5', username: 'c', displayName: 'C', role: 4 } });
  assert.equal(sbOld.user.isBroadcaster, true);
});

test('bots fill only up to the game default, adjustable with !bg bots', async () => {
  const tubesManifest = JSON.parse(readFileSync(new URL('../games/tubes/manifest.json', import.meta.url)));
  const tubes = await import('../games/tubes/logic.js');
  const bridge = new DevBridge();
  const registry = createRegistry([{ ...tubesManifest, needs: [] }], async () => tubes);
  const s = new Session({ bridge, registry, scheduler: fakeScheduler(), config: { predictions: false } });
  await s.openLobby('tubes');
  bridge.inject('alice: !join');
  bridge.inject('!bg start');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.activeSeatIdx.length, 4, 'default botFillTo = 4');
  s.stop();

  await s.openLobby('tubes');
  bridge.inject('alice: !join');
  bridge.inject('!bg bots 8');
  bridge.inject('!bg start');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.activeSeatIdx.length, 8);
  s.stop();

  await s.openLobby('tubes');
  bridge.inject('alice: !join');
  bridge.inject('!bg bots 0');
  bridge.inject('!bg start');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.activeSeatIdx.length, 2, 'still at least min players');
});
