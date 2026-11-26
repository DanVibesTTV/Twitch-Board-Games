import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, FINISH, absSquare } from '../games/ludo/logic.js';
import { createRng } from '../core/rng.js';

function playOut(seed, seats = ['red', 'green', 'yellow', 'blue']) {
  const g = createGame({ seats, rng: createRng(seed) });
  let steps = 0;
  while (g.decision() && steps < 20000) {
    g.apply(g.botChoice());
    steps++;
  }
  return { g, steps };
}

test('bots finish full games for many seeds', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { g, steps } = playOut(seed);
    assert.ok(steps < 20000, `seed ${seed} did not finish`);
    assert.equal(g.decision(), null);
    const r = g.ranking();
    assert.equal(new Set(r).size, 4);
    // Everyone except the last place has all pawns home.
    for (const seat of r.slice(0, 3)) assert.ok(g.state.pawns[seat].every((p) => p === FINISH));
  }
});

test('two-player games work', () => {
  const { g } = playOut(7, ['red', 'yellow']);
  assert.equal(g.ranking().length, 2);
});

test('need a 6 to leave the yard', () => {
  const rng = { int: () => 3, next: () => 0.5 };
  const g = createGame({ seats: ['red', 'green'], rng });
  g.apply(0); // roll 3 → no moves, stuck → retry
  assert.equal(g.state.current, 0);
  assert.equal(g.state.phase, 'roll');
  g.apply(0); g.apply(0); // 3 tries used
  assert.equal(g.state.current, 1);
});

test('capture sends opponent home, safe squares protect', () => {
  // green pawn sits on absolute square 5 (green progress 44), red pawn at progress 2, red rolls 3
  const g2 = createGame({ seats: ['red', 'green'], rng: { int: () => 3, next: () => 0 } });
  g2.state.pawns[1][0] = (5 - 13 + 52) % 52;
  g2.state.pawns[0][0] = 2;
  g2.apply(0); // roll 3
  const d = g2.decision();
  const idx = d.options.findIndex((o) => o.data.pawn === 0);
  assert.ok(d.options[idx].data.captures.length === 1);
  const { events } = g2.apply(idx);
  assert.ok(events.some((e) => e.type === 'capture'));
  assert.equal(g2.state.pawns[1][0], -1);
  assert.equal(absSquare('red', 5), 5);

  // Safe: green pawn on red start square (abs 0) can't be captured
  const g3 = createGame({ seats: ['red', 'green'], rng: { int: () => 6, next: () => 0 } });
  g3.state.pawns[1][0] = (0 - 13 + 52) % 52;
  g3.apply(0);
  const out = g3.decision().options.find((o) => o.data.from === -1);
  assert.equal(out.data.captures.length, 0);
});

test('exact roll needed to finish', () => {
  const g = createGame({ seats: ['red', 'green'], rng: { int: () => 5, next: () => 0 } });
  g.state.pawns[0] = [53, FINISH, FINISH, FINISH];
  g.apply(0); // 53 + 5 = 58 > 56 → no move
  assert.equal(g.state.current, 1);
});
