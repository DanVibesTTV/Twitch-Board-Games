import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, splitPots, FOLD, CALL, RAISE, ALL_IN } from '../games/holdem/logic.js';
import { bestHand, score5, compareScores } from '../games/holdem/cards.js';
import { createRng } from '../core/rng.js';

const c = (rank, suit) => suit * 13 + rank; // rank 0 = 2 … 12 = A

test('hand ranking order', () => {
  const hands = [
    [c(0, 0), c(5, 1), c(7, 2), c(9, 3), c(11, 0)],   // high card
    [c(3, 0), c(3, 1), c(7, 2), c(9, 3), c(11, 0)],   // pair
    [c(3, 0), c(3, 1), c(7, 2), c(7, 3), c(11, 0)],   // two pair
    [c(3, 0), c(3, 1), c(3, 2), c(9, 3), c(11, 0)],   // trips
    [c(12, 0), c(0, 1), c(1, 2), c(2, 3), c(3, 0)],   // wheel straight
    [c(4, 0), c(5, 1), c(6, 2), c(7, 3), c(8, 0)],    // 6-high straight beats the wheel
    [c(0, 1), c(4, 1), c(7, 1), c(9, 1), c(11, 1)],   // flush
    [c(3, 0), c(3, 1), c(3, 2), c(9, 3), c(9, 0)],    // full house
    [c(3, 0), c(3, 1), c(3, 2), c(3, 3), c(11, 0)],   // quads
    [c(8, 2), c(9, 2), c(10, 2), c(11, 2), c(12, 2)], // royal flush
  ].map(score5);
  for (let i = 1; i < hands.length; i++) assert.equal(compareScores(hands[i], hands[i - 1]), 1, `hand ${i} beats hand ${i - 1}`);
  assert.equal(bestHand([c(12, 0), c(11, 0), c(10, 0), c(9, 0), c(8, 0), c(0, 1), c(1, 2)]).name, 'Royal flush');
  assert.equal(bestHand([c(12, 1), c(0, 0), c(1, 2), c(2, 3), c(3, 0), c(10, 1), c(10, 2)]).name, 'Straight, Five high');
  // kicker decides
  assert.equal(compareScores(score5([c(12, 0), c(12, 1), c(9, 2), c(5, 3), c(2, 0)]), score5([c(12, 2), c(12, 3), c(9, 0), c(4, 1), c(2, 1)])), 1);
});

test('side pots: short all-in wins only the main pot; folded chips stay in the pot', () => {
  // A (seat 0) all-in 100, B and C 300 each, D folded after putting in 50.
  const totals = [100, 300, 300, 50];
  const strong = [9, 9], mid = [5, 5], weak = [1, 1];
  // A has the best hand, B second, C worst.
  const { pots, payout } = splitPots(totals, new Map([[0, strong], [1, mid], [2, weak]]), 3);
  assert.deepEqual(pots.map((p) => p.amount), [350, 400]);
  assert.deepEqual(pots.map((p) => p.eligible), [[0, 1, 2], [1, 2]]);
  assert.deepEqual(payout, [350, 400, 0, 0]);
  assert.equal(payout.reduce((a, b) => a + b, 0), 750);
});

test('side pots: an uncalled excess goes back, ties split with the odd chip left of the dealer', () => {
  // A shoves 1000, B calls all-in for 300: A gets the 700 nobody could match.
  let r = splitPots([1000, 300], new Map([[0, [1]], [1, [9]]]), 0);
  assert.deepEqual(r.payout, [700, 600]);
  // Three-way tie on 101 chips; dealer is seat 2, so seat 0 (first left of the dealer) gets the extra chip.
  r = splitPots([34, 34, 33], new Map([[0, [5]], [1, [5]], [2, [5]]]), 2);
  assert.deepEqual(r.payout, [34, 34, 33]);
  assert.equal(r.payout.reduce((a, b) => a + b, 0), 101);
});

test('heads-up: the dealer posts the small blind and acts first before the flop', () => {
  const g = createGame({ seats: ['a', 'b'], rng: createRng(7) });
  const s = g.state;
  const dealer = s.dealer;
  assert.equal(s.players[dealer].bet, 10);
  assert.equal(s.players[1 - dealer].bet, 20);
  assert.equal(g.decision().seat, dealer);
  const d = g.decision();
  assert.equal(d.options[FOLD].disabled, false);
  assert.equal(d.options[CALL].label, 'Call 10');
  assert.equal(d.options[RAISE].label, 'Raise to 40');
  g.apply(CALL);
  // the big blind may still raise, so it's their turn, with a free check
  assert.equal(g.decision().seat, 1 - dealer);
  assert.equal(g.decision().options[CALL].label, 'Check');
  assert.equal(g.decision().options[FOLD].disabled, true, 'no folding when checking is free');
  g.apply(CALL);
  assert.equal(s.street, 'flop');
  assert.equal(s.board.length, 3);
  assert.equal(g.decision().seat, 1 - dealer, 'after the flop the big blind (non-dealer) starts');
});

test('timeout: check when it is free, otherwise fold', () => {
  const g = createGame({ seats: ['a', 'b', 'c'], rng: createRng(3) });
  assert.equal(g.timeoutChoice(), FOLD); // facing the big blind
  g.apply(CALL); g.apply(CALL);
  assert.equal(g.decision().options[CALL].label, 'Check'); // big blind
  assert.equal(g.timeoutChoice(), CALL);
});

test('a raise reopens the betting for everyone still in', () => {
  const g = createGame({ seats: ['a', 'b', 'c'], rng: createRng(11) });
  const first = g.decision().seat;
  g.apply(CALL);
  const second = g.decision().seat;
  g.apply(RAISE);
  assert.equal(g.state.currentBet, 40);
  // the remaining two must answer, including the player who already called
  const answered = new Set();
  for (let k = 0; k < 2; k++) { answered.add(g.decision().seat); g.apply(CALL); }
  assert.ok(answered.has(first));
  assert.ok(!answered.has(second));
  assert.equal(g.state.street, 'flop');
});

// Plays whole tournaments with bots and random choices; checks the rules hold at every step.
for (const players of [2, 3, 6]) {
  test(`full tournaments (${players} players): chips are conserved, views never leak hidden cards`, () => {
    for (let seed = 1; seed <= 4; seed++) {
      const seats = Array.from({ length: players }, (_, i) => `p${i}`);
      const g = createGame({ seats, rng: createRng(seed * 97 + players), rules: { startChips: 300, blindsEvery: 4 } });
      const start = players * 300;
      const pick = createRng(seed);
      let moves = 0;
      while (g.decision() && moves < 5000) {
        const d = g.decision();
        // everything on the table + in front of players + in stacks adds up
        const onTable = g.state.players.reduce((s, p) => s + p.chips + p.total, 0);
        assert.equal(onTable, start, `chips conserved (hand ${g.state.hand})`);
        // views: own cards visible, others' face down unless shown
        for (let v = -1; v < players; v++) {
          const view = g.viewFor(v === -1 ? null : v);
          assert.ok(!('deck' in view));
          view.players.forEach((p, i) => {
            const real = g.state.players[i];
            if (i !== v && !real.shown) assert.ok(p.cards.every((x) => x === -1), 'hidden cards stay hidden');
            if (i === v) assert.deepEqual(p.cards, real.cards);
          });
        }
        const legal = d.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
        const choice = moves % 3 === 0 ? g.botChoice() : legal[pick.int(0, legal.length - 1)];
        const { events } = g.apply(choice);
        for (const e of events) {
          if (e.cards) assert.ok(e.type === 'board', `only board events carry cards (${e.type})`);
          if (e.type === 'showdown') for (const sh of e.shown) assert.ok(g.state.lastResult.shown.some((x) => x.seat === sh.seat));
        }
        moves++;
      }
      assert.equal(g.decision(), null, 'tournament finished');
      assert.equal(g.state.over, true);
      const rank = g.ranking();
      assert.equal(rank.length, players);
      assert.equal(new Set(rank).size, players);
      assert.equal(g.state.players[rank[0]].chips, start, 'the winner has every chip');
    }
  });
}

test('bots: never pick a disabled option, fold rubbish to a big bet, never fold a free check', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = createGame({ seats: ['a', 'b', 'c', 'd'], rng: createRng(seed) });
    for (let k = 0; k < 40 && g.decision(); k++) {
      const d = g.decision();
      const b = g.botChoice();
      assert.ok(!d.options[b].disabled);
      if (d.options[CALL].label === 'Check') assert.notEqual(b, FOLD);
      g.apply(b);
    }
  }
  // 7-2 offsuit facing an all-in: fold.
  const g = createGame({ seats: ['a', 'b'], rng: createRng(5) });
  const me = g.decision().seat;
  g.state.players[me].cards = [c(5, 0), c(0, 1)];
  g.apply(CALL); // the dealer limps
  // now the big blind shoves
  g.apply(ALL_IN);
  const d = g.decision();
  assert.equal(d.seat, me);
  assert.equal(g.botChoice(), FOLD);
});
