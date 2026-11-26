// Jazzy Dice: five dice, three rolls per turn, fill your scorecard. Implements the Game API (docs/GAME_API.md).
//
// A turn:
//   1. roll step:  !roll
//   2. hold step:  !1–!5 hold/release a die, !roll again (rolls the dice that aren't held), !score.
//                  Shortcut: !keep 135 holds exactly dice 1, 3, 5 and rolls (hidden options, see `command`).
//   3. score step: !1–!13 pick a box on the scorecard (!14 back to the dice while rolls are left).
// After the third roll the turn goes straight to the score step.
//
// Scoring follows the classic rules: upper bonus 35 at 63+, "Jazz" (five alike) 50, every further Jazz
// +100 when the Jazz box holds 50, and the joker rule for further Jazzes.

export const CATEGORIES = [
  { id: 'ones', name: 'Ones', short: '1s', upper: 1 },
  { id: 'twos', name: 'Twos', short: '2s', upper: 2 },
  { id: 'threes', name: 'Threes', short: '3s', upper: 3 },
  { id: 'fours', name: 'Fours', short: '4s', upper: 4 },
  { id: 'fives', name: 'Fives', short: '5s', upper: 5 },
  { id: 'sixes', name: 'Sixes', short: '6s', upper: 6 },
  { id: 'three', name: 'Three of a kind', short: '3K', alias: '3k' },
  { id: 'four', name: 'Four of a kind', short: '4K', alias: '4k' },
  { id: 'house', name: 'Full house', short: 'FH', alias: 'fh' },
  { id: 'small', name: 'Small straight', short: 'SS', alias: 'ss' },
  { id: 'large', name: 'Large straight', short: 'LS', alias: 'ls' },
  { id: 'jazz', name: 'JAZZ (five alike)', short: 'JZ', alias: 'jazz' },
  { id: 'chance', name: 'Chance', short: 'CH', alias: 'chance' },
];
const CAT_INDEX = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));
export const UPPER_BONUS_AT = 63;
export const UPPER_BONUS = 35;
export const JAZZ_BONUS = 100;

export const DEFAULT_RULES = {
  rounds: 13,          // turns per player (Quick mode: fewer; unused boxes just stay empty)
  upperBonus: true,    // 35 points for 63+ in the upper section
};

// ---------------- scoring ----------------

const counts = (dice) => { const c = [0, 0, 0, 0, 0, 0, 0]; for (const d of dice) c[d]++; return c; };
const sum = (dice) => dice.reduce((a, b) => a + b, 0);
const isJazz = (dice) => dice.every((d) => d === dice[0]);
function longestRun(c) {
  let best = 0;
  let run = 0;
  for (let v = 1; v <= 6; v++) { run = c[v] ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

// Points `dice` score in category `cat` (index), ignoring joker rules.
export function scoreFor(cat, dice) {
  const c = counts(dice);
  const max = Math.max(...c);
  switch (CATEGORIES[cat].id) {
    case 'three': return max >= 3 ? sum(dice) : 0;
    case 'four': return max >= 4 ? sum(dice) : 0;
    case 'house': return c.includes(3) && c.includes(2) ? 25 : 0;
    case 'small': return longestRun(c) >= 4 ? 30 : 0;
    case 'large': return longestRun(c) === 5 ? 40 : 0;
    case 'jazz': return max === 5 ? 50 : 0;
    case 'chance': return sum(dice);
    default: { const face = CATEGORIES[cat].upper; return c[face] * face; }
  }
}

// What each box would score right now for a player, applying the joker rule for a second Jazz.
// Returns [{ points, allowed }] per category; `allowed` = false for filled boxes and joker restrictions.
export function boxOptions(card, dice) {
  const open = card.map((v) => v === null);
  const jazzRolled = isJazz(dice) && card[CAT_INDEX.jazz] !== null;
  return CATEGORIES.map((cat, i) => {
    if (!open[i]) return { points: card[i], allowed: false };
    if (!jazzRolled) return { points: scoreFor(i, dice), allowed: true };
    // Joker rule: the matching upper box first; else any lower box at full value; else any upper box for 0.
    const upperBox = dice[0] - 1;
    if (open[upperBox]) return { points: i === upperBox ? scoreFor(i, dice) : 0, allowed: i === upperBox };
    const lowerOpen = CATEGORIES.some((c, j) => !c.upper && open[j]);
    if (lowerOpen) {
      if (cat.upper) return { points: 0, allowed: false };
      const full = { house: 25, small: 30, large: 40 }[cat.id];
      return { points: full ?? scoreFor(i, dice), allowed: true };
    }
    return { points: 0, allowed: true }; // only upper boxes left: zero
  });
}

export function upperSum(card) {
  return CATEGORIES.reduce((n, c, i) => n + (c.upper && card[i] !== null ? card[i] : 0), 0);
}

export function totals(card, jazzBonus, rules = DEFAULT_RULES) {
  const upper = upperSum(card);
  const bonus = rules.upperBonus && upper >= UPPER_BONUS_AT ? UPPER_BONUS : 0;
  const lower = CATEGORIES.reduce((n, c, i) => n + (!c.upper && card[i] !== null ? card[i] : 0), 0);
  return { upper, bonus, lower, jazzBonus, total: upper + bonus + lower + jazzBonus };
}

// ---------------- bot ----------------

// Rough average a box scores over a game; the bot keeps about this much "in reserve" per open box,
// so it scratches weak boxes (Ones, Jazz) instead of wasting good ones.
const EXPECTED = [2.1, 5.3, 8.6, 12.2, 15.7, 19.2, 21.7, 13.1, 22.6, 29.5, 32.7, 16.9, 22.0];
const key = (dice) => [...dice].sort((a, b) => a - b).join('');

// Precomputed once: the 252 possible hands (sorted), every kept subset (462), and for each kept subset
// the hands that rerolling the rest can produce, with their probabilities.
const HANDS = [];
const SUBS = [];
(function enumerate(prefix, min) {
  SUBS.push(prefix);
  if (prefix.length === 5) { HANDS.push(prefix); return; }
  for (let v = min; v <= 6; v++) enumerate([...prefix, v], v);
})([], 1);
const HAND_INDEX = new Map(HANDS.map((h, i) => [h.join(''), i]));
const SUB_INDEX = new Map(SUBS.map((h, i) => [h.join(''), i]));
const OUTCOMES = SUBS.map((kept) => {
  const n = 5 - kept.length;
  const total = 6 ** n;
  const tally = new Map();
  for (let x = 0; x < total; x++) {
    const d = [...kept];
    for (let i = 0, v = x; i < n; i++, v = Math.floor(v / 6)) d.push((v % 6) + 1);
    const h = HAND_INDEX.get(key(d));
    tally.set(h, (tally.get(h) ?? 0) + 1);
  }
  return [...tally].map(([h, c]) => [h, c / total]);
});
const subsOf = (dice) => {
  const out = new Set();
  for (let mask = 0; mask < 32; mask++) out.add(SUB_INDEX.get(key(dice.filter((_, i) => mask & (1 << i)))));
  return [...out];
};
const HAND_SUBS = HANDS.map(subsOf);

// How good ending the turn with `dice` is: best box by points minus what that box is usually worth.
function utility(card, dice, rules) {
  const opts = boxOptions(card, dice);
  const upperNow = upperSum(card);
  let best = -Infinity;
  let bestCat = -1;
  opts.forEach((o, i) => {
    if (!o.allowed) return;
    let u = o.points - EXPECTED[i] * 0.6;
    const face = CATEGORIES[i].upper;
    if (face && rules.upperBonus && upperNow < UPPER_BONUS_AT) {
      // three or more of a face keeps the upper bonus on track
      u += (o.points / face - 3) * face * 0.6;
      if (upperNow + o.points >= UPPER_BONUS_AT) u += 12;
    }
    if (CATEGORIES[i].id === 'jazz' && o.points === 50) u += 10;
    if (isJazz(dice) && card[CAT_INDEX.jazz] === 50) u += JAZZ_BONUS * 0.8;
    if (u > best) { best = u; bestCat = i; }
  });
  return { value: best, cat: bestCat };
}

// Exact expected value of "keep these, reroll the rest" for one and two rolls left.
function planner(card, rules) {
  const end = HANDS.map((h) => utility(card, h, rules).value);
  const ev = (values) => OUTCOMES.map((list) => list.reduce((n, [h, p]) => n + p * values[h], 0));
  const keep1 = ev(end);                                                          // one roll left
  const best1 = HANDS.map((_, h) => Math.max(end[h], ...HAND_SUBS[h].map((s) => keep1[s])));
  const keep2 = ev(best1);                                                        // two rolls left
  return { end, keep: (sub, rollsLeft) => (rollsLeft >= 2 ? keep2 : keep1)[sub] };
}

// Best mask of dice to keep (31 = keep everything, i.e. score now).
export function botKeep(card, dice, rollsLeft, rules = DEFAULT_RULES) {
  const p = planner(card, rules);
  let bestMask = 31;
  let bestV = p.end[HAND_INDEX.get(key(dice))];
  for (let mask = 0; mask < 31; mask++) {
    const v = p.keep(SUB_INDEX.get(key(dice.filter((_, i) => mask & (1 << i)))), rollsLeft);
    if (v > bestV + 1e-9) { bestV = v; bestMask = mask; }
  }
  return bestMask;
}

export function botCategory(card, dice, rules = DEFAULT_RULES) {
  return utility(card, dice, rules).cat;
}

// ---------------- game ----------------

export function createGame({ seats, rng, rules: r = {} }) {
  const rules = { ...DEFAULT_RULES, ...r };
  const n = seats.length;
  const state = {
    rules,
    round: 1,                 // 1-based, for display
    current: 0,
    dice: [1, 2, 3, 4, 5],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    rolled: false,            // dice show this turn's roll (not last turn's)
    step: 'roll',             // 'roll' | 'hold' | 'score'
    cards: Array.from({ length: n }, () => new Array(CATEGORIES.length).fill(null)),
    jazzBonus: new Array(n).fill(0),
    filled: new Array(n).fill(0),
    last: null,               // { seat, cat, points } of the last scored box
    over: false,
  };

  const total = (s) => totals(state.cards[s], state.jazzBonus[s], rules).total;
  const diceText = () => state.dice.map((d, i) => (state.held[i] ? `[${d}]` : `${d}`)).join(' ');

  function decision() {
    if (state.over) return null;
    const s = state.current;
    if (state.step === 'roll') {
      return { seat: s, kind: 'roll', prompt: `Round ${state.round}/${rules.rounds}: roll the dice`, options: [{ label: 'Roll the dice', alias: 'roll' }] };
    }
    if (state.step === 'hold') {
      const heldCount = state.held.filter(Boolean).length;
      const options = state.dice.map((d, i) => ({
        label: `${state.held[i] ? 'Release' : 'Hold'} die ${i + 1} (${d})`,
        data: { die: i },
      }));
      options.push({ label: `Roll ${5 - heldCount} ${5 - heldCount === 1 ? 'die' : 'dice'} again (${state.rollsLeft} left)  · !roll`, alias: 'roll', disabled: heldCount === 5, data: { roll: true } });
      options.push({ label: 'Score these dice  · !score', alias: 'score', data: { score: true } });
      // Hidden: !keep <dice> → hold exactly these and roll (mask 31 = score).
      for (let mask = 0; mask < 32; mask++) options.push({ label: `keep ${mask}`, hidden: true, data: { keep: mask } });
      return {
        seat: s, kind: 'hold', layout: 'list',
        prompt: `Roll ${3 - state.rollsLeft}/3: ${diceText()}. Hold dice, roll again or score (!keep 135 = hold dice 1, 3, 5 and roll)`,
        options,
      };
    }
    const opts = boxOptions(state.cards[s], state.dice);
    const options = CATEGORIES.map((c, i) => ({
      label: `${c.name}: ${opts[i].allowed ? opts[i].points : state.cards[s][i] ?? '–'}`,
      alias: c.alias ?? c.id,
      disabled: !opts[i].allowed,
      data: { cat: i, points: opts[i].points },
    }));
    options.push({ label: 'Back to the dice', alias: 'back', disabled: state.rollsLeft === 0, data: { back: true } });
    return { seat: s, kind: 'score', prompt: `Dice ${state.dice.join(' ')}: pick a box on the scorecard (!1–!13)`, options };
  }

  function roll() {
    const rolled = [];
    state.dice = state.dice.map((d, i) => {
      if (state.held[i]) return d;
      rolled.push(i);
      return rng.int(1, 6);
    });
    state.rollsLeft--;
    state.rolled = true;
    state.step = state.rollsLeft === 0 ? 'score' : 'hold';
    const events = [{ type: 'roll', seat: state.current, dice: [...state.dice], rolled, rollsLeft: state.rollsLeft }];
    if (isJazz(state.dice)) events.push({ type: 'jazz', seat: state.current, value: state.dice[0] });
    return { events, log: [`rolled ${state.dice.join(' ')}`] };
  }

  function score(cat) {
    const s = state.current;
    const card = state.cards[s];
    const opts = boxOptions(card, state.dice);
    if (!opts[cat].allowed) throw new Error('box not available');
    const before = totals(card, state.jazzBonus[s], rules);
    const events = [];
    const log = [];
    let bonus = 0;
    if (isJazz(state.dice) && card[CAT_INDEX.jazz] === 50) {
      bonus = JAZZ_BONUS;
      state.jazzBonus[s] += JAZZ_BONUS;
    }
    card[cat] = opts[cat].points;
    state.filled[s]++;
    const after = totals(card, state.jazzBonus[s], rules);
    state.last = { seat: s, cat, points: card[cat] };
    events.push({ type: 'score', seat: s, cat, points: card[cat], jazzBonus: bonus, total: after.total });
    log.push(`${CATEGORIES[cat].name}: ${card[cat]}${bonus ? ` + ${bonus} Jazz bonus` : ''}`);
    if (!before.bonus && after.bonus) {
      events.push({ type: 'upperBonus', seat: s, points: UPPER_BONUS });
      log.push(`upper bonus +${UPPER_BONUS}`);
    }
    nextTurn(events);
    return { events, log };
  }

  function nextTurn(events) {
    state.held = [false, false, false, false, false];
    state.rollsLeft = 3;
    state.rolled = false;
    state.step = 'roll';
    if (state.filled.every((f) => f >= rules.rounds)) {
      state.over = true;
      events.push({ type: 'gameOver', ranking: ranking() });
      return;
    }
    state.current = (state.current + 1) % n;
    if (state.current === 0) state.round++;
    events.push({ type: 'turn', seat: state.current, round: state.round });
  }

  function apply(index) {
    const d = decision();
    const opt = d?.options[index];
    if (!opt || opt.disabled) throw new Error(`option ${index} not available`);
    if (d.kind === 'roll') return roll();
    if (d.kind === 'hold') {
      const data = opt.data;
      if (data.die !== undefined) {
        state.held[data.die] = !state.held[data.die];
        return { events: [{ type: 'hold', die: data.die, held: state.held[data.die] }], log: [] };
      }
      if (data.score) { state.step = 'score'; return { events: [{ type: 'toScore' }], log: [] }; }
      if (data.keep !== undefined) {
        const events = [];
        for (let i = 0; i < 5; i++) {
          const h = !!(data.keep & (1 << i));
          if (state.held[i] !== h) { state.held[i] = h; events.push({ type: 'hold', die: i, held: h }); }
        }
        if (data.keep === 31) { state.step = 'score'; events.push({ type: 'toScore' }); return { events, log: [] }; }
        const r2 = roll();
        return { events: [...events, ...r2.events], log: r2.log };
      }
      return roll();
    }
    // score step
    if (opt.data.back) { state.step = 'hold'; return { events: [{ type: 'toHold' }], log: [] }; }
    return score(opt.data.cat);
  }

  // !keep 135 / !hold 1 3 5 → hidden "keep" option. Returns an option index, or -1.
  function command(alias, arg) {
    const d = decision();
    if (!d || d.kind !== 'hold' || !['keep', 'hold'].includes(alias)) return -1;
    const digits = String(arg ?? '').replace(/[^1-5]/g, '');
    if (alias === 'hold' && !digits) return -1;
    let mask = 0;
    for (const ch of digits) mask |= 1 << (Number(ch) - 1);
    return d.options.findIndex((o) => o.data?.keep === mask);
  }

  function botChoice() {
    const d = decision();
    if (d.kind === 'roll') return 0;
    const s = state.current;
    if (d.kind === 'hold') {
      const mask = botKeep(state.cards[s], state.dice, state.rollsLeft, rules);
      return d.options.findIndex((o) => o.data?.keep === mask);
    }
    return botCategory(state.cards[s], state.dice, rules);
  }

  function ranking() {
    return seats.map((_, i) => i).sort((a, b) => total(b) - total(a) || a - b);
  }

  function isDraw() {
    if (!state.over || n < 2) return false;
    const r = ranking();
    return total(r[0]) === total(r[1]);
  }

  return { state, decision, apply, command, botChoice, ranking, isDraw, totals: (s) => totals(state.cards[s], state.jazzBonus[s], rules) };
}
