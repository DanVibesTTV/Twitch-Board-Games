import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, TELEPORTERS, TUBES, GOAL } from '../games/tubes/logic.js';
import { createRng } from '../core/rng.js';

const fixed = (...rolls) => ({ int: () => rolls.shift() ?? 1, next: () => 0 });
const SEATS8 = ['pink', 'cyan', 'lime', 'orange', 'violet', 'gold', 'red', 'mint'];

test('8 bots finish games for many seeds; first to 100 wins', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const g = createGame({ seats: SEATS8, rng: createRng(seed) });
    let steps = 0;
    while (g.decision() && steps < 50000) { g.apply(g.botChoice()); steps++; }
    assert.equal(g.decision(), null, `seed ${seed} did not finish`);
    const winner = g.ranking()[0];
    assert.equal(g.state.pos[winner], GOAL);
    assert.equal(g.ranking().length, 8);
  }
});

test('board data is consistent', () => {
  const starts = [...Object.keys(TELEPORTERS), ...Object.keys(TUBES)].map(Number);
  const ends = [...Object.values(TELEPORTERS), ...Object.values(TUBES)];
  for (const [a, b] of Object.entries(TELEPORTERS)) assert.ok(b > a, `teleporter ${a} goes up`);
  for (const [a, b] of Object.entries(TUBES)) assert.ok(b < a, `tube ${a} goes down`);
  assert.equal(starts.filter((s) => ends.includes(s)).length, 0, 'no chains');
  assert.ok(!starts.includes(GOAL));
});

test('teleporter and tube move the player', () => {
  const g = createGame({ seats: ['pink', 'cyan'], rng: fixed(4, 6) });
  let r = g.apply(0); // 0 → 4 → teleport to 25
  assert.ok(r.events.some((e) => e.type === 'teleport' && e.to === 25));
  assert.equal(g.state.pos[0], 25);
  g.state.pos[1] = 21;
  r = g.apply(0); // cyan 21 + 6 = 27 → tube to 5
  assert.ok(r.events.some((e) => e.type === 'tube' && e.to === 5));
  assert.equal(g.state.pos[1], 5);
});

test('overshooting 100 bounces back', () => {
  const g = createGame({ seats: ['pink', 'cyan'], rng: fixed(5) });
  g.state.pos[0] = 97;
  const { events } = g.apply(0); // 98, 99, 100, 99, 98
  const move = events.find((e) => e.type === 'move');
  assert.deepEqual(move.path, [98, 99, 100, 99, 98]);
  assert.equal(g.state.pos[0], 98);
});

test('exact roll wins', () => {
  const g = createGame({ seats: ['pink', 'cyan'], rng: fixed(3) });
  g.state.pos[0] = 97;
  const { events } = g.apply(0);
  assert.ok(events.some((e) => e.type === 'gameOver'));
  assert.equal(g.decision(), null);
});
