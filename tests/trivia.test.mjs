import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RING, HUB, NODE_COUNT, neighbors, nodeInfo, destinations, hqRing, spokeNode, nodePosition } from '../games/trivia/wheel.js';
import { createGame } from '../games/trivia/logic.js';
import { createRng } from '../core/rng.js';

test('wheel graph: symmetric neighbors, 6 HQs, roll-again spaces, every category everywhere', () => {
  assert.equal(NODE_COUNT, 73);
  for (let n = 0; n < NODE_COUNT; n++) for (const m of neighbors(n)) assert.ok(neighbors(m).includes(n), `${n}<->${m}`);
  const kinds = {};
  const slotCounts = new Array(6).fill(0);
  for (let n = 0; n < NODE_COUNT; n++) {
    const i = nodeInfo(n);
    kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    if (i.slot !== null) slotCounts[i.slot]++;
  }
  assert.deepEqual(kinds, { hq: 6, ring: 24, again: 12, spoke: 30, hub: 1 });
  assert.ok(slotCounts.every((c) => c === slotCounts[0]), `categories balanced: ${slotCounts}`);
  for (let k = 0; k < 6; k++) assert.equal(nodeInfo(hqRing(k)).slot, k);
  assert.equal(neighbors(HUB).length, 6);
  assert.equal(neighbors(hqRing(2)).length, 3);
  // no two neighboring spaces share a category (so a 1-step move changes the question)
  for (let n = 0; n < NODE_COUNT; n++) for (const m of neighbors(n)) {
    const a = nodeInfo(n).slot; const b = nodeInfo(m).slot;
    if (a !== null && b !== null) assert.notEqual(a, b, `${n} and ${m} share a category`);
  }
  const [x, y] = nodePosition(hqRing(0));
  assert.ok(Math.abs(x) < 1e-9 && y < 0, 'HQ 0 at the top');
});

test('destinations: exact roll, no backtracking, turning only at HQ/hub', () => {
  // from the hub, 1 step reaches the 6 inner spoke spaces
  assert.equal(destinations(HUB, 1).length, 6);
  // from the hub, 6 steps reaches the 6 HQs
  const six = destinations(HUB, 6).map((d) => d.node).sort((a, b) => a - b);
  assert.deepEqual(six, [0, 7, 14, 21, 28, 35]);
  // from a plain ring space, 2 steps: one each way, never back to the start
  const ringSpace = 3;
  const d2 = destinations(ringSpace, 2).map((d) => d.node).sort((a, b) => a - b);
  assert.deepEqual(d2, [1, 5]);
  // paths never step straight back
  for (const start of [0, 3, 50, HUB]) for (let n = 1; n <= 6; n++) {
    for (const { path } of destinations(start, n)) {
      const full = [start, ...path];
      for (let i = 2; i < full.length; i++) assert.notEqual(full[i], full[i - 2]);
    }
  }
  // from HQ 0 with 1 step: both ring neighbors and the spoke
  assert.deepEqual(destinations(0, 1).map((d) => d.node).sort((a, b) => a - b), [1, spokeNode(0, 1), RING - 1].sort((a, b) => a - b));
});

function playOut(seed, seats, rules) {
  const g = createGame({ seats, rng: createRng(seed), rules });
  let steps = 0;
  while (g.decision() && steps < 200000) { g.apply(g.botChoice()); steps++; }
  return { g, steps };
}

test('bot games finish with a winner holding every wedge (classic and quick)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { g, steps } = playOut(seed, ['red', 'cyan', 'white'], {});
    assert.ok(steps < 200000, `seed ${seed} did not finish`);
    const w = g.state.winner;
    assert.ok(w !== null);
    assert.ok(g.state.wedges[w].every(Boolean));
    assert.equal(g.ranking()[0], w);
  }
  const { g } = playOut(5, ['red', 'cyan'], { wedgesToWin: 3, finalQuestion: false });
  assert.equal(g.state.wedges[g.state.winner].filter(Boolean).length, 3);
});

test('question flow: correct keeps the turn and earns an HQ wedge; timeout counts as wrong', () => {
  const rolls = [6];
  const rng = { ...createRng(1), int: (a, b) => (rolls.length ? rolls.shift() : a) };
  const g = createGame({ seats: ['red', 'cyan'], rng });
  g.apply(0); // roll 6 from the hub
  const d = g.decision();
  assert.equal(d.kind, 'choose');
  assert.match(d.options[0].label, /HQ: wedge!$/, 'missing wedges listed first');
  g.apply(0); // move to an HQ
  const q = g.decision();
  assert.equal(q.kind, 'question');
  assert.equal(q.seconds, 30);
  assert.ok(q.question.hq);
  g.apply(g.state.question.correctIndex);
  assert.equal(g.state.wedges[0].filter(Boolean).length, 1);
  assert.equal(g.state.current, 0, 'correct answer keeps the turn');
  assert.equal(g.timeoutChoice(), undefined, 'not a question decision');
  // next: roll 1 → move → question → timeout
  rolls.push(1);
  g.apply(0); g.apply(0);
  if (g.decision().kind === 'question') {
    assert.equal(g.timeoutChoice(), 'timeout');
    const { events } = g.apply('timeout');
    assert.ok(events.some((e) => e.type === 'answer' && e.timeout && !e.correct));
    assert.equal(g.state.current, 1, 'turn passes on a miss');
  }
});

test('final question: next player picks the category', () => {
  const g = createGame({ seats: ['red', 'cyan', 'white'], rng: createRng(3) });
  g.state.wedges[0] = new Array(6).fill(true);
  g.state.pos[0] = spokeNode(0, 5); // one step from the hub
  const rng = g.state; // keep the real rng
  // roll until a 1 comes up
  for (let i = 0; i < 50 && !(g.state.phase === 'move' && g.state.dests.some((d) => d.node === HUB)); i++) {
    if (g.state.phase !== 'roll') break;
    g.apply(0);
    if (!g.state.dests.some((d) => d.node === HUB)) { g.state.phase = 'roll'; g.state.current = 0; g.state.pos[0] = spokeNode(0, 5); }
  }
  const idx = g.state.dests.findIndex((d) => d.node === HUB);
  assert.ok(idx >= 0);
  assert.match(g.decision().options[idx].label, /FINAL/);
  g.apply(idx);
  const pick = g.decision();
  assert.equal(pick.seat, 1, 'the next player picks');
  assert.match(pick.prompt, /FINAL category for Red/);
  g.apply(2);
  const fq = g.decision();
  assert.equal(fq.kind, 'question');
  assert.ok(fq.question.final);
  g.apply(g.state.question.correctIndex);
  assert.equal(g.state.winner, 0);
  assert.equal(g.decision(), null);
});
