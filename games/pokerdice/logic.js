// Poker Dice: five dice with 9, 10, J, Q, K, A faces. Implements the Game API (docs/GAME_API.md).
//
// Each round every player takes one turn: up to three rolls, holding dice in between (same controls
// as Jazzy Dice: !1–!5, !roll, !keep 135), then !stand. The best poker hand of the round wins a
// doubloon (ties: everyone tied gets one). First to `target` doubloons wins, as long as they lead alone.
//
// Faces are stored as 1–6 = 9, 10, J, Q, K, A.

import { HANDS, key, bestKeep, holdOptions, rollDice, applyHold, keepCommand } from '../../core/dice.js';

export const FACES = ['9', '10', 'J', 'Q', 'K', 'A'];
export const FACE_NAMES = ['Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
export const RANKS = ['Bust', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Full house', 'Four of a kind', 'Five of a kind'];

export const DEFAULT_RULES = {
  target: 3,       // doubloons needed to win the match
  maxRounds: 15,   // safety stop; a tie after that is a draw
};

// ---------------- hands ----------------

// { rank, name, score } — score compares lexicographically (rank first, then the values that matter).
export function evaluate(dice) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) c[d]++;
  const groups = [];
  for (let v = 6; v >= 1; v--) if (c[v]) groups.push([c[v], v]);
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const shape = groups.map((g) => g[0]).join('');
  const values = groups.map((g) => g[1]);
  const straight = groups.length === 5 && (c[1] === 0 || c[6] === 0);
  let rank;
  if (shape === '5') rank = 7;
  else if (shape === '41') rank = 6;
  else if (shape === '32') rank = 5;
  else if (straight) rank = 4;
  else if (shape === '311') rank = 3;
  else if (shape === '221') rank = 2;
  else if (shape === '2111') rank = 1;
  else rank = 0;
  const score = straight ? [4, c[6] ? 6 : 5] : [rank, ...values];
  return { rank, name: describe(rank, values, c), score };
}

function describe(rank, values, c) {
  const n = (v) => FACE_NAMES[v - 1];
  switch (rank) {
    case 7: return `Five ${n(values[0])}`;
    case 6: return `Four ${n(values[0])}`;
    case 5: return `Full house, ${n(values[0])} over ${n(values[1])}`;
    case 4: return c[6] ? 'High straight (10–A)' : 'Low straight (9–K)';
    case 3: return `Three ${n(values[0])}`;
    case 2: return `Two pair, ${n(values[0])} and ${n(values[1])}`;
    case 1: return `Pair of ${n(values[0])}`;
    default: return `Bust, ${FACES[values[0] - 1]} high`;
  }
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

export function compare(a, b) {
  for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) {
    const d = (a.score[i] ?? 0) - (b.score[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ---------------- bot ----------------

// How strong a hand is: the share of single random rolls it beats (ties count half). Precomputed.
const STRENGTH = (() => {
  const evals = HANDS.map((h) => evaluate(h));
  const prob = new Array(HANDS.length).fill(0);
  const index = new Map(HANDS.map((h, i) => [h.join(''), i]));
  for (let x = 0; x < 7776; x++) {
    const d = [];
    for (let i = 0, v = x; i < 5; i++, v = Math.floor(v / 6)) d.push((v % 6) + 1);
    prob[index.get(key(d))] += 1 / 7776;
  }
  return HANDS.map((_, i) => evals.reduce((n, e, j) => n + prob[j] * (compare(evals[i], e) > 0 ? 1 : compare(evals[i], e) === 0 ? 0.5 : 0), 0));
})();
const STRENGTH_BY_KEY = new Map(HANDS.map((h, i) => [h.join(''), STRENGTH[i]]));

// best: the best finished hand of this round so far (or null); later: players still to play after the bot.
export function botValue(hand, best, later) {
  const strength = STRENGTH_BY_KEY.get(key(hand));
  if (!best) return strength;
  const c = compare(evaluate(hand), best);
  const beat = c > 0 ? 1 : c === 0 ? 0.6 : 0;
  return beat + (later > 0 ? 0.5 : 0.01) * strength;
}

// ---------------- game ----------------

export function createGame({ seats, rng, rules: r = {} }) {
  const rules = { ...DEFAULT_RULES, ...r };
  const n = seats.length;
  const state = {
    rules,
    round: 1,
    order: seats.map((_, i) => i),   // turn order of this round (the start rotates)
    turn: 0,                          // index into order
    current: 0,
    dice: [1, 2, 3, 4, 5],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    rolled: false,
    step: 'roll',                     // 'roll' | 'hold'
    hands: new Array(n).fill(null),   // this round: { dice, ...evaluate } once a player stands
    coins: new Array(n).fill(0),
    lastRound: null,                  // { round, winners, hands } after a round ends
    over: false,
  };

  const faceText = (d) => FACES[d - 1];
  const diceText = () => state.dice.map((d, i) => (state.held[i] ? `[${faceText(d)}]` : faceText(d))).join(' ');

  // Best finished hand this round, and who holds it.
  function leader() {
    let best = null;
    let who = -1;
    state.hands.forEach((h, i) => { if (h && (!best || compare(h, best) > 0)) { best = h; who = i; } });
    return { best, who };
  }

  function decision() {
    if (state.over) return null;
    const s = state.current;
    const { best, who } = leader();
    const toBeat = best ? ` Hand to beat: ${best.name} (${cap(seats[who])}).` : '';
    if (state.step === 'roll') {
      return { seat: s, kind: 'roll', prompt: `Round ${state.round}: roll the dice.${toBeat}`, options: [{ label: 'Roll the dice', alias: 'roll' }] };
    }
    return {
      seat: s, kind: 'hold', layout: 'list',
      prompt: `Roll ${3 - state.rollsLeft}/3: ${diceText()} = ${evaluate(state.dice).name}.${toBeat}`,
      options: holdOptions(state, { faceName: faceText, done: { label: 'Stand with this hand', alias: 'stand' } }),
    };
  }

  function roll() {
    const rolled = rollDice(state, rng);
    state.rolled = true;
    state.step = 'hold';
    const hand = evaluate(state.dice);
    const events = [{ type: 'roll', seat: state.current, dice: [...state.dice], rolled, rollsLeft: state.rollsLeft, hand: hand.name, rank: hand.rank }];
    const log = [`rolled ${state.dice.map(faceText).join(' ')}: ${hand.name}`];
    if (state.rollsLeft === 0) {
      const r2 = stand();
      return { events: [...events, ...r2.events], log: [...log, ...r2.log] };
    }
    return { events, log };
  }

  function stand() {
    const s = state.current;
    const hand = { dice: [...state.dice], ...evaluate(state.dice) };
    state.hands[s] = hand;
    const events = [{ type: 'stand', seat: s, hand }];
    const log = [`stands: ${hand.name}`];
    nextTurn(events, log);
    return { events, log };
  }

  function nextTurn(events, log) {
    state.held = [false, false, false, false, false];
    state.rollsLeft = 3;
    state.rolled = false;
    state.step = 'roll';
    state.turn++;
    if (state.turn < n) {
      state.current = state.order[state.turn];
      events.push({ type: 'turn', seat: state.current, round: state.round });
      return;
    }
    // round over: best hand(s) win a doubloon
    const { best } = leader();
    const winners = state.hands.map((h, i) => (compare(h, best) === 0 ? i : -1)).filter((i) => i >= 0);
    for (const w of winners) state.coins[w]++;
    state.lastRound = { round: state.round, winners, hands: state.hands.map((h) => h && { dice: h.dice, name: h.name, rank: h.rank }) };
    events.push({ type: 'roundEnd', round: state.round, winners, best: best.name, coins: [...state.coins], hands: state.hands.map((h) => ({ ...h })) });
    log.push(`round ${state.round}: ${winners.map((w) => cap(seats[w])).join(' & ')} ${winners.length > 1 ? 'tie' : 'wins'} with ${best.name}`);

    const top = Math.max(...state.coins);
    const leaders = state.coins.filter((c) => c === top).length;
    if ((top >= rules.target && leaders === 1) || state.round >= rules.maxRounds) {
      state.over = true;
      events.push({ type: 'gameOver', ranking: ranking() });
      return;
    }
    state.round++;
    const start = (state.round - 1) % n;
    state.order = seats.map((_, i) => (start + i) % n);
    state.turn = 0;
    state.current = state.order[0];
    state.hands = new Array(n).fill(null);
    events.push({ type: 'turn', seat: state.current, round: state.round, newRound: true });
  }

  function apply(index) {
    const d = decision();
    const opt = d?.options[index];
    if (!opt || opt.disabled) throw new Error(`option ${index} not available`);
    if (d.kind === 'roll') return roll();
    return applyHold(state, opt, { roll, done: stand });
  }

  function command(alias, arg) {
    return keepCommand(decision(), alias, arg);
  }

  function botChoice() {
    const d = decision();
    if (d.kind === 'roll') return 0;
    const { best } = leader();
    const later = n - 1 - state.turn;
    const mask = bestKeep(state.dice, state.rollsLeft, (hand) => botValue(hand, best, later));
    return d.options.findIndex((o) => o.data?.keep === mask);
  }

  function ranking() {
    return seats.map((_, i) => i).sort((a, b) => state.coins[b] - state.coins[a] || a - b);
  }

  function isDraw() {
    if (!state.over || n < 2) return false;
    const r = ranking();
    return state.coins[r[0]] === state.coins[r[1]];
  }

  return { state, decision, apply, command, botChoice, ranking, isDraw };
}
