import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, chooseMove, emptyBoard, winningLine, COLS, ROWS } from '../games/four/logic.js';
import { createRng } from '../core/rng.js';

const play = (g, cols) => { for (const c of cols) g.apply(c); };

test('vertical, horizontal and both diagonal wins are detected', () => {
  let g = createGame({ seats: ['red', 'yellow'], rng: createRng(1) });
  play(g, [0, 1, 0, 1, 0, 1, 0]); // red stacks column 1
  assert.equal(g.decision(), null);
  assert.equal(g.ranking()[0], 0);
  assert.equal(g.state.line.length, 4);

  g = createGame({ seats: ['red', 'yellow'], rng: createRng(1) });
  play(g, [0, 0, 1, 1, 2, 2, 3]); // red bottom row 1–4
  assert.equal(g.state.winner, 0);

  const b = emptyBoard();
  [[0, 0], [1, 1], [2, 2], [3, 3]].forEach(([c, r]) => { b[c][r] = 1; });
  assert.ok(winningLine(b, 2, 2));
  const b2 = emptyBoard();
  [[3, 0], [2, 1], [1, 2], [0, 3]].forEach(([c, r]) => { b2[c][r] = 0; });
  assert.ok(winningLine(b2, 1, 2));
});

test('all 7 columns are always listed; full ones are disabled', () => {
  const g = createGame({ seats: ['red', 'yellow'], rng: createRng(1) });
  play(g, [2, 2, 2, 2, 2, 2]);
  const d = g.decision();
  assert.equal(d.options.length, COLS);
  assert.equal(d.options[2].disabled, true);
  assert.equal(d.options.filter((o) => o.disabled).length, 1);
  assert.throws(() => g.apply(2));
});

test('a full board without four is a draw', () => {
  const g = createGame({ seats: ['red', 'yellow'], rng: createRng(1) });
  // Column order that fills the board with no line of four
  const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6];
  play(g, order);
  assert.equal(g.state.moves, COLS * ROWS);
  assert.equal(g.isDraw(), true);
  assert.equal(g.decision(), null);
});

test('bot takes an immediate win and blocks an immediate loss', () => {
  const R = { botDepth: 5, botMistakes: 1 }; // even with max "mistakes" it must not blunder these
  const b = emptyBoard();
  b[0][0] = 0; b[1][0] = 0; b[2][0] = 0;     // red threatens column 4
  b[0][1] = 1; b[1][1] = 1;                  // yellow scattered
  assert.equal(chooseMove(b, 0, R), 3, 'red wins');
  assert.equal(chooseMove(b, 1, R), 3, 'yellow blocks');
});

test('bots finish games and the strong bot beats a random player', () => {
  let wins = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const rng = createRng(seed);
    const g = createGame({ seats: ['red', 'yellow'], rng, rules: { botDepth: 4, botMistakes: 0 } });
    while (g.decision()) {
      const d = g.decision();
      if (d.seat === 0) g.apply(g.botChoice());
      else {
        const open = d.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
        g.apply(rng.pick(open));
      }
    }
    if (!g.isDraw() && g.ranking()[0] === 0) wins++;
  }
  assert.ok(wins >= 19, `bot won only ${wins}/20 vs random`);
});

test('bot move is fast enough at default depth', () => {
  const g = createGame({ seats: ['red', 'yellow'], rng: createRng(3) });
  const t = performance.now();
  for (let i = 0; i < 10 && g.decision(); i++) g.apply(g.botChoice());
  assert.ok((performance.now() - t) / 10 < 200, 'average bot move under 200 ms');
});
