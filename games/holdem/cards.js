// Playing cards and poker hand evaluation (pure, no graphics).
// A card is a number 0–51: rank = card % 13 (0 = 2 … 12 = A), suit = floor(card / 13).

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const RANK_NAMES = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const SINGULAR = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
export const SUITS = ['♠', '♥', '♦', '♣'];
export const CATEGORIES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

export const rankOf = (c) => c % 13;
export const suitOf = (c) => Math.floor(c / 13);
export const cardText = (c) => `${RANKS[rankOf(c)]}${SUITS[suitOf(c)]}`;
export const isRed = (c) => suitOf(c) === 1 || suitOf(c) === 2;

// Best 5-card score: [category, …tie-breakers], higher is better.
export function score5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Groups by size, then rank: e.g. full house [[3, K], [2, 7]].
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...new Set(ranks)];
  let straightHigh = -1;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique[0] === 12 && unique[1] === 3) straightHigh = 3; // A-2-3-4-5 (wheel)
  }
  if (straightHigh >= 0 && flush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straightHigh >= 0) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  return [0, ...ranks];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Best hand from 5–7 cards: { score, cards (the 5 used), name }. Tries every 5-card combination
// (at most 21 for 7 cards).
export function bestHand(cards) {
  let best = null;
  let bestCards = null;
  const n = cards.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let bits = 0;
    for (let m = mask; m; m &= m - 1) bits++;
    if (bits !== 5) continue;
    const pick = cards.filter((_, i) => mask & (1 << i));
    const s = score5(pick);
    if (!best || compareScores(s, best) > 0) { best = s; bestCards = pick; }
  }
  return { score: best, cards: bestCards, name: handName(best) };
}

export function handName(s) {
  const r = (i) => RANK_NAMES[i];
  switch (s[0]) {
    case 8: return s[1] === 12 ? 'Royal flush' : `Straight flush, ${SINGULAR[s[1]]} high`;
    case 7: return `Four ${r(s[1])}`;
    case 6: return `Full house, ${r(s[1])} over ${r(s[2])}`;
    case 5: return `Flush, ${SINGULAR[s[1]]} high`;
    case 4: return `Straight, ${SINGULAR[s[1]]} high`;
    case 3: return `Three ${r(s[1])}`;
    case 2: return `Two pair, ${r(s[1])} and ${r(s[2])}`;
    case 1: return `Pair of ${r(s[1])}`;
    default: return `${SINGULAR[s[1]]} high`;
  }
}
