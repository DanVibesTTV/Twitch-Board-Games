import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, evaluate, compare } from '../games/pokerdice/logic.js';
import { createRng } from '../core/rng.js';

// faces: 1=9 2=10 3=J 4=Q 5=K 6=A
const ev = (s) => evaluate(s.split('').map(Number));

test('hand ranks and names', () => {
  assert.equal(ev('66666').name, 'Five Aces');
  assert.equal(ev('55551').rank, 6);
  assert.equal(ev('55511').name, 'Full house, Kings over Nines');
  assert.equal(ev('12345').name, 'Low straight (9–K)');
  assert.equal(ev('23456').name, 'High straight (10–A)');
  assert.equal(ev('33312').rank, 3);
  assert.equal(ev('44221').name, 'Two pair, Queens and Tens');
  assert.equal(ev('66123').name, 'Pair of Aces');
  assert.equal(ev('12356').name, 'Bust, A high');
});

test('hand order and tie-breaks', () => {
  const order = ['12356', '11234', '11223', '11123', '12345', '23456', '11122', '11112', '11111'];
  for (let i = 1; i < order.length; i++) assert.equal(compare(ev(order[i]), ev(order[i - 1])), 1, `${order[i]} > ${order[i - 1]}`);
  assert.equal(compare(ev('55511'), ev('44466')), 1, 'full house: the triple decides');
  assert.equal(compare(ev('66541'), ev('66532')), 1, 'pair: kickers decide');
  assert.equal(compare(ev('21345'), ev('54321')), 0, 'order of dice does not matter');
});

test('a round: each player one turn, stand or three rolls; best hand gets a doubloon', () => {
  const g = createGame({ seats: ['scarlet', 'ocean'], rng: createRng(5) });
  g.apply(0);                         // roll
  assert.equal(g.decision().kind, 'hold');
  g.apply(6);                         // stand
  assert.equal(g.state.current, 1);
  assert.ok(g.state.hands[0]);
  g.apply(0);                         // roll
  g.apply(g.command('keep', ''));     // reroll all
  g.apply(5);                         // roll again → third roll ends the turn
  assert.equal(g.state.round, 2);
  assert.equal(g.state.coins.reduce((a, b) => a + b, 0) >= 1, true);
  assert.equal(g.state.current, 1, 'round 2 starts with the next player');
});

test('bots finish 150 matches; winner has the target and leads alone', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const seats = seed % 3 === 0 ? ['a', 'b', 'c'] : ['a', 'b'];
    const g = createGame({ seats, rng: createRng(seed) });
    let steps = 0;
    while (g.decision()) {
      g.apply(g.botChoice());
      if (++steps > 3000) throw new Error('match did not end');
    }
    const r = g.ranking();
    if (!g.isDraw()) {
      assert.ok(g.state.coins[r[0]] >= 3);
      assert.ok(g.state.coins[r[0]] > g.state.coins[r[1]]);
    }
  }
});

test('bot keeps what wins and rolls for more when behind', () => {
  const g = createGame({ seats: ['a', 'b'], rng: createRng(1) });
  g.state.hands[0] = { dice: [1, 1, 2, 3, 4], ...evaluate([1, 1, 2, 3, 4]) }; // pair of nines
  Object.assign(g.state, { turn: 1, current: 1, step: 'hold', rollsLeft: 2, rolled: true, dice: [6, 6, 1, 2, 3] }); // pair of aces
  const opt = g.decision().options[g.botChoice()];
  assert.equal(opt.data.keep & 0b00011, 0b00011, 'never gives up the winning aces');
  g.state.hands[0] = { dice: [5, 5, 5, 1, 1], ...evaluate([5, 5, 5, 1, 1]) }; // full house to beat
  const opt2 = g.decision().options[g.botChoice()];
  assert.notEqual(opt2.data.keep, 31, 'keeps rolling when behind');
  assert.equal(opt2.data.keep & 0b00011, 0b00011, 'keeps the aces');
});

// ---- through the session ----
import { readFileSync } from 'node:fs';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { DevBridge } from '../bridges/dev.js';
import * as poker from '../games/pokerdice/logic.js';

test('session: !stand and !keep work, bots finish a quick match, prediction resolved', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../games/pokerdice/manifest.json', import.meta.url)));
  const bridge = new DevBridge();
  const calls = [];
  bridge.sendChat = async () => {};
  bridge.prediction = { create: async () => calls.push('create'), lock: async () => {}, resolve: async () => calls.push('resolve'), cancel: async () => calls.push('cancel') };
  let now = 0; let id = 0;
  const timers = new Map();
  const scheduler = { setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (i) => timers.delete(i) };
  const tick = () => new Promise((r) => setImmediate(r));
  const s = new Session({ bridge, registry: createRegistry([manifest], async () => poker), scheduler, config: { afterGame: 'menu', afkLimit: 1 } });
  await s.openLobby('pokerdice', 'quick');
  bridge.inject('alice: !join scarlet');
  bridge.inject('bob: !join ocean');
  bridge.inject('!bg start');
  await tick();
  bridge.inject('alice: !roll');
  await tick(); await tick();
  bridge.inject('alice: !keep 1');
  await tick(); await tick();
  assert.equal(s.game.state.rollsLeft, 1);
  bridge.inject('alice: !stand');
  await tick(); await tick();
  assert.ok(s.game.state.hands[0], 'alice stood');
  assert.equal(s.game.state.current, 1);
  for (let n = 0; n < 200000; n++) {
    await tick(); await tick();
    if (!timers.size) break;
    const [i, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(i); now = t.at; t.fn();
  }
  assert.equal(s.phase, 'menu');
  assert.ok(calls.includes('create') && (calls.includes('resolve') || calls.includes('cancel')));
});
