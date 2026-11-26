// Shared helpers for "five dice, up to three rolls, hold what you like" games (Jazzy Dice, Poker Dice).
//
// - Exact planning for bots: every possible hand (252 sorted hands), every kept subset (462) and the
//   probabilities of what rerolling the rest produces. A game supplies how good a final hand is;
//   plan() returns the expected value of each "keep these and reroll" choice.
// - The hold step: options !1–!5 (hold/release), roll again, a "done" option, plus 32 hidden
//   "hold exactly these and roll" options reached with !keep 135 (see Game API: hidden options).

export const key = (dice) => [...dice].sort((a, b) => a - b).join('');

export const HANDS = [];
const SUBS = [];
(function enumerate(prefix, min) {
  SUBS.push(prefix);
  if (prefix.length === 5) { HANDS.push(prefix); return; }
  for (let v = min; v <= 6; v++) enumerate([...prefix, v], v);
})([], 1);
export const HAND_INDEX = new Map(HANDS.map((h, i) => [h.join(''), i]));
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
const HAND_SUBS = HANDS.map((dice) => {
  const out = new Set();
  for (let mask = 0; mask < 32; mask++) out.add(SUB_INDEX.get(key(dice.filter((_, i) => mask & (1 << i)))));
  return [...out];
});

// value(hand) → number for every sorted hand. Returns { end, keep(sub, rollsLeft) } with exact
// expectations for one and two rolls left.
function plan(value) {
  const end = HANDS.map(value);
  const ev = (values) => OUTCOMES.map((list) => list.reduce((n, [h, p]) => n + p * values[h], 0));
  const keep1 = ev(end);
  const best1 = HANDS.map((_, h) => Math.max(end[h], ...HAND_SUBS[h].map((s) => keep1[s])));
  const keep2 = ev(best1);
  return { end, keep: (sub, rollsLeft) => (rollsLeft >= 2 ? keep2 : keep1)[sub] };
}

// Best mask of dice to keep given the current (unsorted) dice; 31 = keep everything (stop rolling).
export function bestKeep(dice, rollsLeft, value) {
  const p = plan(value);
  let bestMask = 31;
  let bestV = p.end[HAND_INDEX.get(key(dice))];
  for (let mask = 0; mask < 31; mask++) {
    const v = p.keep(SUB_INDEX.get(key(dice.filter((_, i) => mask & (1 << i)))), rollsLeft);
    if (v > bestV + 1e-9) { bestV = v; bestMask = mask; }
  }
  return bestMask;
}

// ---------------- the hold step ----------------

// The options of a hold decision. faceName(v) names a face for labels; done = { label, alias }.
export function holdOptions(state, { faceName = String, done }) {
  const heldCount = state.held.filter(Boolean).length;
  const options = state.dice.map((d, i) => ({ label: `${state.held[i] ? 'Release' : 'Hold'} die ${i + 1} (${faceName(d)})`, data: { die: i } }));
  options.push({
    label: `Roll ${5 - heldCount} ${5 - heldCount === 1 ? 'die' : 'dice'} again (${state.rollsLeft} left)  · !roll`,
    alias: 'roll', disabled: heldCount === 5, data: { roll: true },
  });
  options.push({ label: `${done.label}  · !${done.alias}`, alias: done.alias, data: { done: true } });
  for (let mask = 0; mask < 32; mask++) options.push({ label: `keep ${mask}`, hidden: true, data: { keep: mask } });
  return options;
}

// Rolls the dice that aren't held. Returns the indices that were rolled.
export function rollDice(state, rng) {
  const rolled = [];
  state.dice = state.dice.map((d, i) => {
    if (state.held[i]) return d;
    rolled.push(i);
    return rng.int(1, 6);
  });
  state.rollsLeft--;
  return rolled;
}

// Applies a hold-step option. roll() and done() are the game's own (they return { events, log }).
export function applyHold(state, opt, { roll, done }) {
  const data = opt.data;
  if (data.die !== undefined) {
    state.held[data.die] = !state.held[data.die];
    return { events: [{ type: 'hold', die: data.die, held: state.held[data.die] }], log: [] };
  }
  if (data.done) return done();
  if (data.keep !== undefined) {
    const events = [];
    for (let i = 0; i < 5; i++) {
      const h = !!(data.keep & (1 << i));
      if (state.held[i] !== h) { state.held[i] = h; events.push({ type: 'hold', die: i, held: h }); }
    }
    const next = data.keep === 31 ? done() : roll();
    return { events: [...events, ...next.events], log: next.log };
  }
  return roll();
}

// !keep 135 / !hold 1 3 5 → index of the hidden keep option, or -1.
export function keepCommand(decision, alias, arg) {
  if (!decision || decision.kind !== 'hold' || !['keep', 'hold'].includes(alias)) return -1;
  const digits = String(arg ?? '').replace(/[^1-5]/g, '');
  if (alias === 'hold' && !digits) return -1;
  let mask = 0;
  for (const ch of digits) mask |= 1 << (Number(ch) - 1);
  return decision.options.findIndex((o) => o.data?.keep === mask);
}
