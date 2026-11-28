// Neon Chess: rules engine (perft), notation, the two-step numbered decisions, typed moves,
// promotion, clocks, draws, the bot, and whole games through the Session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromFen, toFen, legalMoves, makeMove, toSan, parseMove, botMove } from '../games/chess/engine.js';
import { createGame } from '../games/chess/logic.js';
import { createRng } from '../core/rng.js';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { DevBridge } from '../bridges/dev.js';
import * as chess from '../games/chess/logic.js';

const perft = (P, d) => (d === 0 ? 1 : legalMoves(P).reduce((n, m) => n + perft(makeMove(P, m), d - 1), 0));

test('chess engine: move generation matches the standard perft counts', () => {
  const cases = [
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902]],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039]], // castling, pins, en passant
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264]], // promotions
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486]],
  ];
  for (const [fen, want] of cases) assert.deepEqual(want.map((_, i) => perft(fromFen(fen), i + 1)), want, fen);
  assert.equal(toFen(fromFen(cases[1][0])), cases[1][0]);
});

test('chess engine: notation both ways', () => {
  const P = fromFen();
  for (const [typed, san] of [['e4', 'e4'], ['Nf3', 'Nf3'], ['nf3', 'Nf3'], ['e2e4', 'e4'], ['g1-f3', 'Nf3'], ['NC3', 'Nc3']]) {
    assert.equal(toSan(P, parseMove(P, typed)), san, typed);
  }
  assert.equal(parseMove(P, 'e5'), null);
  assert.equal(parseMove(P, 'hello'), null);
  // lowercase "bxc4": the b-pawn and a bishop could both take on c4 — pawn reading when the bishop can't
  const Q = fromFen('4k3/8/8/8/2p5/1P6/8/4K3 w - - 0 1');
  assert.equal(toSan(Q, parseMove(Q, 'bxc4')), 'bxc4');
  const B = fromFen('4k3/8/8/8/2p5/8/8/4KB2 w - - 0 1');
  assert.equal(toSan(B, parseMove(B, 'bxc4')), 'Bxc4');
  // disambiguation and check marks
  const R = fromFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert.equal(toSan(R, parseMove(R, 'rd1')), 'Rd1', 'the h1 Mech is blocked by the king');
  const R2 = fromFen('4k3/8/8/8/8/8/4K3/R6R w - - 0 1');
  assert.equal(toSan(R2, parseMove(R2, 'rad1')), 'Rad1');
  assert.equal(parseMove(R2, 'rd1'), null, 'ambiguous without the file');
  assert.equal(toSan(R, parseMove(R, 'ra8')), 'Ra8+');
  assert.equal(parseMove(R, 'a8'), null, 'no piece letter = a Runner move');
  assert.equal(toSan(R, parseMove(R, 'O-O')), 'O-O');
});

const idx = (g, pred) => g.decision().options.findIndex(pred);
const pick = (g, label) => {
  const i = idx(g, (o) => !o.hidden && o.label.startsWith(label));
  assert.ok(i >= 0, `no option "${label}" in ${g.decision().options.filter((o) => !o.hidden).map((o) => o.label)}`);
  return g.apply(i);
};

test('chess: pick a piece, then a square; back; typed moves; fool\'s mate', () => {
  const g = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 0 } });
  let d = g.decision();
  assert.equal(d.seat, 0);
  const pieces = d.options.filter((o) => !o.hidden);
  assert.equal(pieces.length, 10, '8 Runners and 2 Jetpacks can move');
  assert.equal(pieces[0].label, 'Jetpack b1', 'numbered strongest first');
  assert.equal(d.seconds, 90);

  pick(g, 'Runner f2');
  d = g.decision();
  assert.equal(d.step, 'target');
  assert.deepEqual(d.options.filter((o) => !o.hidden).map((o) => o.label), ['f3', 'f4', 'Back — pick another piece']);
  pick(g, 'Back');
  assert.equal(g.decision().step, 'piece');
  pick(g, 'Runner f2');
  const r = pick(g, 'f3');
  assert.equal(r.events[0].type, 'move');
  assert.equal(r.events[0].san, 'f3');
  assert.equal(g.decision().seat, 1);

  // typed moves (chat sends them lowercased)
  assert.equal(g.command('nf3'), -1, 'not a legal move for magenta');
  g.apply(g.command('e5'));
  g.apply(g.command('g4'));
  const res = g.apply(g.command('qh4'));
  assert.equal(res.events[0].san, 'Qh4#');
  assert.deepEqual(res.events.map((e) => e.type), ['move', 'win']);
  assert.equal(g.decision(), null);
  assert.deepEqual(g.ranking(), [1, 0]);
  assert.equal(g.state.result, 'checkmate');
  assert.deepEqual(g.state.sans, ['f3', 'e5', 'g4', 'Qh4#']);
});

test('chess: promotion asks which piece; castling and en passant tell the renderer what moved', () => {
  const g = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 0, fen: 'r3k3/1P6/8/3pP3/8/8/8/R3K2R w KQq d6 0 1' } });
  // en passant
  let r = g.apply(g.command('exd6'));
  assert.equal(r.events[0].ep, true);
  assert.equal(r.events[0].capturedAt, 35, 'the captured Runner stood on d5');
  g.apply(g.command('kd7'));
  // promotion through the steps: piece, square (a capture on a8), then the piece type
  pick(g, 'Runner b7');
  pick(g, 'a8');
  const d = g.decision();
  assert.equal(d.step, 'promo');
  assert.deepEqual(d.options.filter((o) => !o.hidden).map((o) => o.label), ['Assassin', 'Mech', 'Technomancer', 'Jetpack']);
  r = pick(g, 'Jetpack');
  assert.equal(r.events[0].san, 'bxa8=N');
  assert.equal(r.events[0].promo, 2);
  g.apply(g.command('kxd6'));
  r = g.apply(g.command('o-o'));
  assert.deepEqual(r.events[0].castle, { from: 7, to: 5 }, 'the Mech jumps from h1 to f1');
});

test('chess: clocks run down with each decision; out of time loses — or draws against a bare king', () => {
  const g = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 1, increment: 2 } });
  assert.equal(g.decision().seconds, 60);
  g.apply(g.command('e4'), { elapsedMs: 10000 });
  assert.equal(g.state.clock[0], 52000, '60 − 10 + 2 increment');
  assert.equal(g.decision().seconds, 60);
  const flag = g.timeoutChoice();
  assert.equal(g.decision().options[flag].data.kind, 'flag');
  const r = g.apply(flag, { elapsedMs: 60000 });
  assert.equal(r.events.at(-1).type, 'win');
  assert.deepEqual(g.ranking(), [0, 1]);
  assert.equal(g.state.result, 'time');

  const h = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 1, fen: '4k3/8/8/8/8/8/4P3/4K2q w - - 0 1' } });
  h.apply(h.command('kd2'), { elapsedMs: 1000 });
  h.apply(h.timeoutChoice(), { elapsedMs: 70000 });
  assert.equal(h.state.winner, 0, 'magenta flagged; cyan still has a Runner, so cyan wins');
  const k = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 1, fen: '4k3/8/8/8/8/8/8/4K2q w - - 0 1' } });
  k.apply(k.timeoutChoice(), { elapsedMs: 70000 });
  assert.equal(k.state.winner, 1, 'cyan flagged and magenta has a queen: magenta wins');
  const m = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 1, fen: '4k3/8/8/8/8/8/8/4K2Q b - - 0 1' } });
  m.apply(m.timeoutChoice(), { elapsedMs: 70000 });
  assert.equal(m.isDraw(), false, 'magenta flagged against a queen: cyan wins');
  const n = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 1, fen: '4k3/8/8/8/8/8/8/4K1N1 b - - 0 1' } });
  n.apply(n.timeoutChoice(), { elapsedMs: 70000 });
  assert.equal(n.isDraw(), true, 'a lone Jetpack can\'t checkmate: draw');
});

test('chess: draws — stalemate, repetition, insufficient material; resign', () => {
  const st = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 0, fen: '7k/8/6Q1/8/8/8/8/K7 w - - 0 1' } });
  st.apply(st.command('qf7'));
  assert.equal(st.state.result, 'stalemate');
  assert.equal(st.isDraw(), true);

  const rep = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 0 } });
  for (const m of ['nf3', 'nf6', 'ng1', 'ng8', 'nf3', 'nf6', 'ng1', 'ng8']) rep.apply(rep.command(m));
  assert.equal(rep.state.result, 'repetition');

  const mat = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 0, fen: '4k3/8/8/8/8/8/3n4/4K3 w - - 0 1' } });
  mat.apply(mat.command('kxd2'));
  assert.equal(mat.state.result, 'material');

  const res = createGame({ seats: ['cyan', 'magenta'], rng: createRng(1), rules: { clockMinutes: 0 } });
  res.apply(res.command('resign'));
  assert.equal(res.state.result, 'resign');
  assert.deepEqual(res.ranking(), [1, 0]);
});

test('chess bot: finds mate in one, takes a free queen, and plays only legal moves', () => {
  const P = fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  for (const level of [1, 2, 3, 4]) assert.equal(toSan(P, botMove(P, level, () => 0.5)), 'Qxf7#', `level ${level}`);
  const g = createGame({ seats: ['cyan', 'magenta'], rng: createRng(3), rules: { clockMinutes: 0, fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4' } });
  const r = g.apply(g.botChoice());
  assert.equal(r.events[0].san, 'Qxf7#', 'botChoice() is a whole move, whatever step');
  const Q = fromFen('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
  for (const level of [2, 3, 4]) assert.equal(toSan(Q, botMove(Q, level, () => 0.5)), 'Rxd5', `level ${level}`);
});

test('chess through the Session: bots play whole games to a result, with and without clocks', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../games/chess/manifest.json', import.meta.url)));
  for (const mode of ['relaxed', 'blitz']) {
    const bridge = new DevBridge();
    bridge.sendChat = async () => {};
    const fast = { setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 1)); t.unref?.(); return t; }, clearTimeout: (t) => clearTimeout(t) };
    const s = new Session({ bridge, registry: createRegistry([manifest], async () => chess), scheduler: fast, config: { predictions: false, botDelayMs: 1, autoSingleMoveMs: 1, overSeconds: 0.01, minHumans: 0 } });
    let over = null;
    let result = null;
    s.on('gameOver', (o) => { over = o; result = s.game?.state.result; });
    await s.openLobby('chess', mode);
    await s.start(); // nobody joins: two bots
    for (let i = 0; i < 200 && !s.game; i++) await new Promise((r) => setImmediate(r));
    // speed: weak bots, short game
    s.game.rules.botLevel = 1;
    s.game.rules.maxPlies = 120;
    const until = Date.now() + 60000;
    while (!over && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(over, `${mode}: the game ended`);
    assert.ok(['checkmate', 'stalemate', 'repetition', 'fifty', 'material', 'length', 'time'].includes(result), result);
    s.stop?.();
  }
});
