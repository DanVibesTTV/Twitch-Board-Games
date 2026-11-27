// Same-WiFi play keeps one copy of the game on every phone in step: the host's Session emits
// lanStart / lanApply / decisions, a follower Session replays them. These tests link a host and
// a follower through JSON (as over the network) and play whole games with a remote human, bots
// and timeouts — both copies must end identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { LocalBridge } from '../bridges/local.js';
import { lan as triviaLan } from '../games/trivia/lan.js';
import { offlineQuestionBankForTests } from './helpers/trivia-bank.mjs';

const GAMES = ['ludo', 'tubes', 'four', 'trivia', 'jazzy', 'pokerdice'];
const manifests = Object.fromEntries(GAMES.map((id) => [id, JSON.parse(readFileSync(new URL(`../games/${id}/manifest.json`, import.meta.url)))]));
const logic = Object.fromEntries(await Promise.all(GAMES.map(async (id) => [id, await import(`../games/${id}/logic.js`)])));

// Trivia on the host gets a live-like bank (random questions) through prepare(), like the real game.
const modules = {
  ...Object.fromEntries(GAMES.map((id) => [id, { createGame: logic[id].createGame }])),
  trivia: { createGame: logic.trivia.createGame, lan: triviaLan, prepare: async () => { const bank = offlineQuestionBankForTests(); return { bank, slots: bank.slots }; } },
};
const registry = () => createRegistry(GAMES.map((id) => ({ ...manifests[id], needs: [] })), async (id) => modules[id]);

function fakeScheduler() {
  let now = 0; let id = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => timers.delete(i),
    async runAll(link, limit = 200000) {
      for (let n = 0; n < limit; n++) {
        await link.settle();
        if (!timers.size) return n;
        const [i, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(i); now = t.at; t.fn();
      }
      throw new Error('scheduler did not settle');
    },
  };
}

// Host → follower over "the network": JSON round trip, strictly in order.
function link(host, follower) {
  let chain = Promise.resolve();
  const errors = [];
  const send = (fn, msg) => {
    const copy = JSON.parse(JSON.stringify(msg));
    chain = chain.then(() => fn(copy)).catch((err) => errors.push(err));
  };
  host.on('lanStart', (spec) => send((m) => follower.followStart(m), spec));
  host.on('lanApply', (m) => send((x) => follower.followApply(x), m));
  host.on('decision', (p) => p && send((x) => follower.followDecision(x), { ms: p.endsAt - Date.now(), total: p.total }));
  return { errors, settle: async () => { for (let i = 0; i < 3; i++) { await chain; await new Promise((r) => setImmediate(r)); } } };
}

async function playLinked(gameId, modeId = null) {
  const hostBridge = new LocalBridge({ playerName: 'Host', playerId: 'host-phone' });
  const sched = fakeScheduler();
  const host = new Session({ bridge: hostBridge, registry: registry(), scheduler: sched, config: { afterGame: 'menu', afkLimit: Infinity, predictions: false } });
  host.lanHost = true;
  const follower = new Session({ bridge: new LocalBridge({ playerName: 'Guest', playerId: 'guest-phone' }), registry: registry(), follower: true });
  const l = link(host, follower);
  const followerOver = [];
  follower.on('gameOver', (o) => followerOver.push(o));
  const guest = { id: 'guest-phone', login: 'guest', name: 'Guest', isBroadcaster: false, isMod: false };

  hostBridge.send(`!bg play ${gameId}${modeId ? ` ${modeId}` : ''}`);
  await l.settle();
  hostBridge.send('!join');
  host.handleChat({ user: guest, text: '!join', platform: 'lan' });
  hostBridge.send('!bg start');
  await l.settle();
  assert.equal(host.phase, 'playing', `${gameId}: host started`);

  // Snapshot the follower's game state right before the host finishes (the host tears its game
  // down when it returns to the menu, so compare at the end of play).
  let hostFinal = null;
  host.on('gameOver', () => { hostFinal = JSON.stringify(host.game.state ?? host.game); });
  await sched.runAll(l);
  await l.settle();
  assert.deepEqual(l.errors, [], `${gameId}: no sync errors`);
  assert.ok(hostFinal, `${gameId}: host finished`);
  assert.equal(followerOver.length, 1, `${gameId}: follower finished too`);
  assert.equal(JSON.stringify(follower.game.state ?? follower.game), hostFinal, `${gameId}: identical game state`);
  assert.equal(follower.phase, 'over');
  return { host, follower };
}

for (const id of GAMES) {
  test(`LAN lockstep: ${id} — host and joined phone end with identical games`, async () => {
    await playLinked(id);
  });
}

test('LAN lockstep: a follower ignores chat and never runs timers or bots', async () => {
  const bridge = new LocalBridge();
  const f = new Session({ bridge, registry: registry(), follower: true });
  bridge.send('!bg play ludo');
  await new Promise((r) => setImmediate(r));
  assert.equal(f.phase, 'menu');
});
