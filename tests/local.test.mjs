import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { createBridge } from '../bridges/index.js';
import { LocalBridge } from '../bridges/local.js';
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
        await new Promise((r) => setImmediate(r));
        if (!timers.size) return n;
        const [i, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(i); now = t.at; t.fn();
      }
      throw new Error('scheduler did not settle');
    },
  };
}

test('local bridge: the player is the broadcaster and connects without a network', async () => {
  const bridge = createBridge('local', { playerName: '  Dan  ' });
  assert.ok(bridge instanceof LocalBridge);
  assert.equal(bridge.user.name, 'Dan');
  assert.equal(bridge.user.isBroadcaster, true);
  assert.equal(bridge.capabilities.predictions, false);
  const states = [];
  bridge.on('status', (st) => states.push(st.state));
  await bridge.connect();
  assert.deepEqual(states, ['connected']);
  assert.equal(new LocalBridge().user.name, 'You');
});

test('local bridge: tapping Play (join + start) fills the other seats with bots and the game finishes', async () => {
  const bridge = new LocalBridge();
  const registry = createRegistry([{ ...manifest, needs: [] }], async () => ludo);
  const sched = fakeScheduler();
  const s = new Session({ bridge, registry, scheduler: sched, config: { afterGame: 'menu', turnSeconds: 90, afkLimit: Infinity, predictions: false } });
  const over = [];
  s.on('gameOver', (o) => over.push(o));

  bridge.send('!bg play ludo');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.phase, 'lobby');
  bridge.send('!bg bots 3');
  assert.equal(s.botFillTo, 3);
  bridge.send('!join');
  bridge.send('!bg start');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.phase, 'playing');
  const occupied = s.seats.filter((x) => x.occupant);
  assert.equal(occupied.length, 3);
  assert.equal(occupied.filter((x) => x.occupant.type === 'human').length, 1);

  // Nobody taps: timeouts play the local player's moves, but the seat is never handed to a bot.
  await sched.runAll();
  assert.equal(over.length, 1);
  assert.equal(s.phase, 'menu');
  assert.ok(s.seats.some((x) => x.occupant?.type === 'human' && x.occupant.user.id === 'local-player'));
});
