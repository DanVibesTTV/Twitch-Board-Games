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
    // run only the earliest timer (after letting async work settle)
    async runNext() {
      await new Promise((r) => setImmediate(r));
      if (!timers.size) return false;
      const [i, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(i); now = t.at; t.fn();
      await new Promise((r) => setImmediate(r));
      return true;
    },
    async runOne() { return this.runNext(); },
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

// ── Four in a Row: modes, random draw, predictions, draws ──
async function fourSetup(extra = {}) {
  const man = JSON.parse(readFileSync(new URL('../games/four/manifest.json', import.meta.url)));
  const four = await import('../games/four/logic.js');
  const bridge = new DevBridge();
  bridge.calls = [];
  bridge.prediction = {
    create: async (...a) => bridge.calls.push(['create', ...a]),
    lock: async () => {},
    resolve: async (i) => bridge.calls.push(['resolve', i]),
    cancel: async () => bridge.calls.push(['cancel']),
  };
  const registry = createRegistry([{ ...man, needs: [] }], async () => ({ ...four, ...extra }));
  const sched = fakeScheduler();
  const s = new Session({ bridge, registry, scheduler: sched, config: { afterGame: 'menu', afkLimit: 1 } });
  return { s, bridge, sched };
}
const tick = () => new Promise((r) => setImmediate(r));

test('Duel the Streamer: streamer gets Red, one entrant is drawn for Yellow, prediction opens', async () => {
  const { s, bridge, sched } = await fourSetup();
  bridge.inject('!bg play four streamer'); // typed by the streamer
  await tick();
  assert.equal(s.mode.id, 'streamer');
  assert.equal(s.seats[0].occupant.user.name, 'streamer');
  for (const n of ['a', 'b', 'c', 'd']) bridge.inject(`${n}: !join`);
  bridge.inject('a: !join'); // duplicate ignored
  assert.equal(s.entrants.size, 4);
  assert.equal(s.seats[1].occupant, null, 'nobody seated before the draw');
  await sched.runAll();
  const create = bridge.calls.find((c) => c[0] === 'create');
  assert.ok(create, 'prediction created');
  assert.match(create[2][0], /^streamer \(Red\)$/);
  assert.match(create[2][1], /^[abcd] \(Yellow\)$/);
  assert.ok(bridge.calls.some((c) => c[0] === 'resolve' || c[0] === 'cancel'));
});

test('Duel the Streamer opened by a mod waits for the streamer', async () => {
  const { s, bridge } = await fourSetup();
  bridge.inject('@moddy: !bg play four streamer');
  await tick();
  assert.equal(s.seats[0].occupant.type, 'reserved');
  bridge.inject('viewer: !join red'); // viewers can't take the streamer seat
  assert.equal(s.seats[0].occupant.type, 'reserved');
  bridge.inject('@moddy: !bg start');
  await tick();
  assert.equal(s.phase, 'lobby', 'does not start without the streamer');
  bridge.inject('streamer: !join');
  assert.equal(s.seats[0].occupant.user.name, 'streamer');
});

test('Viewer Duel draws two different viewers', async () => {
  const { s, bridge } = await fourSetup();
  bridge.inject('!bg play four duel');
  await tick();
  for (const n of ['a', 'b', 'c']) bridge.inject(`${n}: !join`);
  bridge.inject('!bg start');
  await tick();
  assert.equal(s.phase, 'playing');
  const names = s.seats.map((x) => x.occupant.user.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((n) => ['a', 'b', 'c'].includes(n)));
  s.stop();
});

test('Chat vs Streamer: Yellow is a crowd seat, full columns are rejected', async () => {
  const { s, bridge } = await fourSetup();
  bridge.inject('!bg play four chat');
  await tick();
  assert.equal(s.seats[0].occupant.user.name, 'streamer');
  assert.equal(s.seats[1].occupant.type, 'crowd');
  bridge.inject('!bg start');
  await tick();
  assert.equal(s.phase, 'playing');
  s.game.state.board[0] = [0, 1, 0, 1, 0, 1]; // column 1 full
  s.game.state.moves = 6;
  s.decision = s.game.decision();
  assert.equal(s.decision.options[0].disabled, true);
  bridge.inject('streamer: !1');
  assert.equal(s.game.state.moves, 6, 'full column ignored');
  bridge.inject('streamer: !2');
  await tick();
  assert.equal(s.game.state.moves, 7);
  s.stop();
});

test('a rejected move restores the turn', async () => {
  const { s, bridge } = await fourSetup();
  bridge.inject('!bg play four duel');
  await tick();
  bridge.inject('a: !join'); bridge.inject('b: !join');
  bridge.inject('!bg start');
  await tick();
  const d = s.decision;
  const who = s.seats[s.activeSeatIdx[d.seat]].occupant.user.name;
  s.game.state.board[3] = [0, 1, 0, 1, 0, 1]; // fill column 4 behind the decision's back
  bridge.inject(`${who}: !4`); // stale "enabled" → game.apply throws
  await tick();
  assert.ok(s.decision, 'turn restored');
  s.stop();
});

test('a draw refunds the prediction', async () => {
  const { s, bridge, sched } = await fourSetup();
  const over = [];
  s.on('gameOver', (o) => over.push(o));
  bridge.inject('!bg play four duel');
  await tick();
  bridge.inject('a: !join'); bridge.inject('b: !join');
  bridge.inject('!bg start');
  await tick();
  s.game.isDraw = () => true;   // end the game as a draw after the next move
  const realDecision = s.game.decision;
  let moved = false;
  s.game.decision = () => (moved ? null : realDecision());
  const realApply = s.game.apply;
  s.game.apply = (i) => { moved = true; return realApply(i); };
  await sched.runAll();
  assert.equal(over[0]?.draw, true);
  assert.ok(bridge.calls.some((c) => c[0] === 'create'));
  assert.ok(bridge.calls.some((c) => c[0] === 'cancel'), 'prediction cancelled on draw');
  assert.ok(!bridge.calls.some((c) => c[0] === 'resolve'));
});

// ── viewer stats ──
test('finished games are recorded; leavers count as played; !bgstats pages and "me"', async () => {
  const { StatsStore } = await import('../core/stats.js');
  const mem = new Map();
  const stats = new StatsStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) });
  const man = JSON.parse(readFileSync(new URL('../games/four/manifest.json', import.meta.url)));
  const four = await import('../games/four/logic.js');
  const bridge = new DevBridge();
  const said = [];
  bridge.sendChat = async (t) => said.push(t);
  const registry = createRegistry([{ ...man, needs: [] }], async () => four);
  const sched = fakeScheduler();
  const s = new Session({ bridge, registry, scheduler: sched, stats, config: { afterGame: 'menu', afkLimit: 1, predictions: false, statsCooldownMs: 0 } });
  const views = [];
  s.on('stats', (v) => views.push(v));

  bridge.inject('!bg play four duel');
  await new Promise((r) => setImmediate(r));
  bridge.inject('a: !join'); bridge.inject('b: !join');
  bridge.inject('!bg start');
  await new Promise((r) => setImmediate(r));
  bridge.inject('a: !leave'); // a leaves mid-game → bot plays for a, but a still "played"
  await sched.runAll();

  const P = stats.data.players;
  assert.equal(P.a.played, 1);
  assert.equal(P.b.played, 1);
  assert.equal(P.a.wins, 0, 'a left: a bot playing for a cannot win for a');
  assert.ok(views.length >= 1, 'HUD notified');
  assert.equal(s.phase, 'menu');

  // paging on the game select screen
  const before = s.statsIndex;
  bridge.inject('viewer: !bgstats');
  assert.equal(s.statsIndex, (before + 1) % s.statsView().pages.length);
  bridge.inject('viewer: !bgstats overall');
  assert.equal(s.statsIndex, 0);
  bridge.inject('b: !bgstats me');
  assert.ok(said.some((t) => t.startsWith('b: ')));
  bridge.inject('nobody: !bgstats me');
  assert.ok(said.some((t) => t.includes('no finished games yet')));

  // reset needs confirm
  bridge.inject('!bg stats reset');
  assert.equal(P.b.played, 1);
  bridge.inject('!bg stats reset confirm');
  assert.deepEqual(stats.data.players, {});
});

test('stopped games are not recorded', async () => {
  const { StatsStore } = await import('../core/stats.js');
  const mem = new Map();
  const stats = new StatsStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) });
  const man = JSON.parse(readFileSync(new URL('../games/four/manifest.json', import.meta.url)));
  const four = await import('../games/four/logic.js');
  const bridge = new DevBridge();
  const s = new Session({ bridge, registry: createRegistry([{ ...man, needs: [] }], async () => four), scheduler: fakeScheduler(), stats, config: { predictions: false } });
  bridge.inject('!bg play four duel');
  await new Promise((r) => setImmediate(r));
  bridge.inject('a: !join'); bridge.inject('b: !join'); bridge.inject('!bg start');
  await new Promise((r) => setImmediate(r));
  bridge.inject('!bg stop');
  assert.deepEqual(stats.data.players, {});
});

// ── hooks used by Trivia Champ ──
test('prepare() context, mode rules and timeout-as-wrong reach the game', async () => {
  const man = JSON.parse(readFileSync(new URL('../games/trivia/manifest.json', import.meta.url)));
  const logic = await import('../games/trivia/logic.js');
  let preloaded = 0;
  let prepared = null;
  const module = {
    ...logic,
    preload: () => { preloaded++; },
    prepare: async (opts) => { prepared = opts; return { marker: 'ctx' }; },
    createGame: (opts) => { module.lastOpts = opts; return logic.createGame(opts); },
  };
  const bridge = new DevBridge();
  const registry = createRegistry([{ ...man, needs: [] }], async () => module);
  const sched = fakeScheduler();
  const s = new Session({ bridge, registry, scheduler: sched, config: { predictions: false, afkLimit: 99 } });
  const events = [];
  s.on('gameEvents', (e) => events.push(...e));
  bridge.inject('!bg play trivia quick');
  await new Promise((r) => setImmediate(r));
  assert.equal(preloaded, 1, 'preload when the lobby opens');
  bridge.inject('alice: !join');
  bridge.inject('!bg start');
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(s.phase, 'playing');
  assert.equal(prepared.rules.wedgesToWin, 3, 'mode rules passed to prepare');
  assert.equal(module.lastOpts.ctx.marker, 'ctx', 'prepare result passed to createGame');
  assert.equal(module.lastOpts.rules.finalQuestion, false);
  // drive alice to a question, then let her time out
  for (let i = 0; i < 200 && !(s.decision?.kind === 'question' && s.decision.seat === 0); i++) {
    if (s.decision?.seat === 0) bridge.inject(s.decision.kind === 'roll' ? 'alice: !roll' : 'alice: !1');
    await sched.runOne?.();
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(s.decision?.kind, 'question', 'reached a question for alice');
  {
    const before = events.length;
    await sched.runNext();
    const answer = events.slice(before).find((e) => e.type === 'answer');
    assert.ok(answer?.timeout, 'a timed-out question counts as a wrong answer, not a bot answer');
  }
  s.stop();
});

test('game admin commands only run in the lobby and refresh the lobby info', async () => {
  const man = JSON.parse(readFileSync(new URL('../games/four/manifest.json', import.meta.url)));
  const four = await import('../games/four/logic.js');
  const seen = [];
  const module = { ...four, adminCommand: (sub, arg, api) => { if (sub !== 'cat') return false; seen.push(arg); api.refresh(); return true; } };
  const bridge = new DevBridge();
  const s = new Session({ bridge, registry: createRegistry([{ ...man, needs: [] }], async () => module), scheduler: fakeScheduler(), config: { predictions: false } });
  let refreshed = 0;
  s.on('lobbyInfo', () => refreshed++);
  bridge.inject('!bg cat 6 sports'); // menu: ignored
  bridge.inject('!bg play four duel');
  await new Promise((r) => setImmediate(r));
  bridge.inject('!bg cat 6 sports');
  bridge.inject('viewer: !bg cat 1 music'); // not a mod
  assert.deepEqual(seen, ['6 sports']);
  assert.equal(refreshed, 1);
});
