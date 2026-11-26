import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, scoreFor, boxOptions, totals, CATEGORIES, botKeep } from '../games/jazzy/logic.js';
import { createRng } from '../core/rng.js';

const cat = (id) => CATEGORIES.findIndex((c) => c.id === id);
const empty = () => new Array(13).fill(null);

test('box scores', () => {
  assert.equal(scoreFor(cat('threes'), [3, 3, 1, 3, 6]), 9);
  assert.equal(scoreFor(cat('three'), [4, 4, 4, 2, 1]), 15);
  assert.equal(scoreFor(cat('three'), [4, 4, 3, 2, 1]), 0);
  assert.equal(scoreFor(cat('four'), [6, 6, 6, 6, 1]), 25);
  assert.equal(scoreFor(cat('house'), [2, 2, 5, 5, 5]), 25);
  assert.equal(scoreFor(cat('house'), [5, 5, 5, 5, 5]), 0, 'five alike is not a full house without the joker');
  assert.equal(scoreFor(cat('small'), [1, 2, 3, 4, 6]), 30);
  assert.equal(scoreFor(cat('small'), [3, 4, 5, 6, 6]), 30);
  assert.equal(scoreFor(cat('small'), [1, 2, 4, 5, 6]), 0);
  assert.equal(scoreFor(cat('large'), [2, 3, 4, 5, 6]), 40);
  assert.equal(scoreFor(cat('large'), [1, 2, 3, 4, 6]), 0);
  assert.equal(scoreFor(cat('jazz'), [4, 4, 4, 4, 4]), 50);
  assert.equal(scoreFor(cat('chance'), [1, 2, 3, 4, 6]), 16);
});

test('joker rule for a second Jazz', () => {
  const card = empty();
  card[cat('jazz')] = 50;
  // matching upper box open → it's the only choice
  let o = boxOptions(card, [5, 5, 5, 5, 5]);
  assert.deepEqual(o.map((x) => x.allowed).filter(Boolean).length, 1);
  assert.equal(o[cat('fives')].points, 25);
  // upper box used → any lower box at full value
  card[cat('fives')] = 15;
  o = boxOptions(card, [5, 5, 5, 5, 5]);
  assert.equal(o[cat('large')].points, 40);
  assert.equal(o[cat('house')].points, 25);
  assert.equal(o[cat('three')].points, 25);
  assert.equal(o[cat('ones')].allowed, false);
  // all lower filled → an upper box for 0
  for (const c of CATEGORIES) if (!c.upper && card[cat(c.id)] === null) card[cat(c.id)] = 0;
  o = boxOptions(card, [5, 5, 5, 5, 5]);
  assert.equal(o[cat('ones')].allowed, true);
  assert.equal(o[cat('ones')].points, 0);
});

test('upper bonus and totals', () => {
  const card = [3, 6, 9, 12, 15, 18, null, null, null, null, null, null, null];
  assert.equal(totals(card, 0).bonus, 35);
  assert.equal(totals(card, 0, { upperBonus: false }).bonus, 0);
  card[0] = 2;
  assert.equal(totals(card, 100).total, 62 + 100);
});

test('turn flow: roll, hold, keep shortcut, score, next player', () => {
  const g = createGame({ seats: ['gold', 'teal'], rng: createRng(7) });
  assert.equal(g.decision().kind, 'roll');
  g.apply(0);
  let d = g.decision();
  assert.equal(d.kind, 'hold');
  assert.equal(d.options.filter((o) => !o.hidden).length, 7);
  g.apply(0); g.apply(2);
  assert.deepEqual(g.state.held, [true, false, true, false, false]);
  const before = [...g.state.dice];
  g.apply(5); // roll again
  assert.equal(g.state.dice[0], before[0]);
  assert.equal(g.state.dice[2], before[2]);
  assert.equal(g.state.rollsLeft, 1);
  // !keep 24 → holds exactly dice 2 and 4, then rolls (last roll → score step)
  const k = g.command('keep', '24');
  assert.ok(g.decision().options[k].hidden);
  const kept = [g.state.dice[1], g.state.dice[3]];
  g.apply(k);
  assert.deepEqual([g.state.dice[1], g.state.dice[3]], kept);
  assert.equal(g.state.rollsLeft, 0);
  d = g.decision();
  assert.equal(d.kind, 'score');
  assert.equal(d.options[13].disabled, true, 'no going back after the third roll');
  g.apply(12); // chance
  assert.equal(g.state.cards[0][12], g.state.dice.reduce((a, b) => a + b, 0));
  assert.equal(g.state.current, 1);
  assert.equal(g.decision().kind, 'roll');
  assert.equal(g.command('keep', '1'), -1, 'no shortcut outside the hold step');
});

test('score now and back to the dice', () => {
  const g = createGame({ seats: ['gold', 'teal'], rng: createRng(3) });
  g.apply(0);
  g.apply(6); // score
  assert.equal(g.decision().kind, 'score');
  g.apply(13); // back
  assert.equal(g.decision().kind, 'hold');
  assert.equal(g.command('keep', '12345'), g.decision().options.findIndex((o) => o.data?.keep === 31));
});

test('bots finish 120 seeded games with sensible scores; quick mode has 7 rounds', () => {
  let sum = 0;
  let count = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const quick = seed % 4 === 0;
    const g = createGame({ seats: ['gold', 'teal'], rng: createRng(seed), rules: quick ? { rounds: 7, upperBonus: false } : {} });
    let steps = 0;
    while (g.decision()) {
      g.apply(g.botChoice());
      if (++steps > 2000) throw new Error('game did not end');
    }
    const filled = g.state.cards[0].filter((v) => v !== null).length;
    assert.equal(filled, quick ? 7 : 13);
    if (!quick) { sum += g.totals(0).total + g.totals(1).total; count += 2; }
    assert.equal(g.ranking().length, 2);
  }
  const avg = sum / count;
  assert.ok(avg > 180 && avg < 320, `bot average ${avg.toFixed(1)} should be in a plausible range`);
});

test('bot keeps four of a kind toward Jazz and scores a large straight right away', () => {
  assert.equal(botKeep(empty(), [6, 6, 6, 6, 2], 2), 0b01111);
  assert.equal(botKeep(empty(), [2, 3, 4, 5, 6], 2), 31);
});

// ---- through the session: !keep shortcut, hidden options, a full bot game ----
import { readFileSync } from 'node:fs';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { DevBridge } from '../bridges/dev.js';
import * as jazzy from '../games/jazzy/logic.js';

const manifest = JSON.parse(readFileSync(new URL('../games/jazzy/manifest.json', import.meta.url)));
function scheduler() {
  let now = 0; let id = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => timers.delete(i),
    async runAll(limit = 200000) {
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
const tick = () => new Promise((r) => setImmediate(r));

test('session: !keep reaches the hidden option, !8 does not; bots finish a quick game', async () => {
  const bridge = new DevBridge();
  bridge.sendChat = async () => {};
  const sched = scheduler();
  const registry = createRegistry([manifest], async () => jazzy);
  const s = new Session({ bridge, registry, scheduler: sched, config: { afterGame: 'menu', afkLimit: 1 } });
  await s.openLobby('jazzy', 'quick');
  bridge.inject('alice: !join gold');
  bridge.inject('!bg start');
  await tick();
  assert.equal(s.phase, 'playing');
  bridge.inject('alice: !roll');
  await tick(); await tick();
  assert.equal(s.decision.kind, 'hold');
  bridge.inject('alice: !8'); // hidden option: ignored
  await tick();
  assert.equal(s.decision?.kind, 'hold');
  assert.deepEqual(s.game.state.held, [false, false, false, false, false]);
  const kept = [s.game.state.dice[0], s.game.state.dice[4]];
  bridge.inject('alice: !keep 15');
  await tick(); await tick();
  assert.deepEqual(s.game.state.held, [true, false, false, false, true]);
  assert.deepEqual([s.game.state.dice[0], s.game.state.dice[4]], kept);
  assert.equal(s.game.state.rollsLeft, 1);
  await sched.runAll(); // alice goes AFK → bots finish
  assert.equal(s.phase, 'menu');
});
