// Texas Hold 'em, tournament style: everyone starts with the same stack of play chips, blinds rise
// every few hands, last player with chips wins. Play chips only — never real money.
//
// Hidden information: `state` holds everything (deck, every hand). Renderers and other phones
// never see it — they get `viewFor(seat)`: only that seat's own cards (and cards shown at a
// showdown). Events and log lines are public and never contain hidden cards.

import { bestHand, compareScores, cardText, rankOf } from './cards.js';

export const DEFAULT_RULES = {
  startChips: 1000,
  smallBlind: 10,   // big blind = 2 × small blind
  blindsEvery: 8,   // hands per blind level (blinds double)
};

// Option numbers are always the same, so "!2" always means check/call.
export const FOLD = 0, CALL = 1, RAISE = 2, HALF_POT = 3, ALL_IN = 4;

export function createGame({ seats, rng, rules: r = {} }) {
  const rules = { ...DEFAULT_RULES, ...r };
  const n = seats.length;
  const state = {
    rules,
    hand: 0,
    level: 0,
    sb: rules.smallBlind,
    bb: rules.smallBlind * 2,
    dealer: -1,
    players: seats.map(() => ({ chips: rules.startChips, cards: [], bet: 0, total: 0, folded: false, allIn: false, out: false, shown: false })),
    board: [],
    deck: [],
    street: 'preflop',  // preflop | flop | turn | river
    toAct: -1,
    currentBet: 0,
    minRaise: 0,
    needs: new Array(n).fill(false), // who still has to act in this betting round
    lastResult: null,   // public result of the previous hand (for the HUD/renderer)
    eliminated: [],     // seat indices, first out first
    over: false,
  };
  const P = state.players;
  const name = (i) => seats[i];

  const inHand = (i) => !P[i].out && !P[i].folded && P[i].cards.length > 0;
  const canAct = (i) => inHand(i) && !P[i].allIn;
  const alive = () => P.map((_, i) => i).filter((i) => !P[i].out);
  const nextFrom = (i, test) => {
    for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (test(j)) return j; }
    return -1;
  };
  const pot = () => P.reduce((s, p) => s + p.total, 0);

  function put(i, amount) {
    const p = P[i];
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.total += a;
    if (p.chips === 0) p.allIn = true;
    return a;
  }

  function shuffle() {
    const d = Array.from({ length: 52 }, (_, i) => i);
    for (let i = d.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  // ── hands ──

  function startHand(events, log) {
    const live = alive();
    if (live.length <= 1) { finishGame(events, log); return; }
    state.hand += 1;
    state.level = Math.floor((state.hand - 1) / rules.blindsEvery);
    state.sb = rules.smallBlind * 2 ** state.level;
    state.bb = state.sb * 2;
    for (const p of P) Object.assign(p, { cards: [], bet: 0, total: 0, folded: false, allIn: false, shown: false });
    state.board = [];
    state.street = 'preflop';
    state.dealer = nextFrom(state.dealer, (j) => !P[j].out);
    const headsUp = live.length === 2;
    const sbSeat = headsUp ? state.dealer : nextFrom(state.dealer, (j) => !P[j].out);
    const bbSeat = nextFrom(sbSeat, (j) => !P[j].out);
    state.deck = shuffle();
    // two cards each, one at a time, starting left of the dealer
    for (let round = 0; round < 2; round++) {
      let j = state.dealer;
      for (let k = 0; k < live.length; k++) { j = nextFrom(j, (x) => !P[x].out); P[j].cards.push(state.deck.pop()); }
    }
    put(sbSeat, state.sb);
    put(bbSeat, state.bb);
    state.currentBet = state.bb;
    state.minRaise = state.bb;
    const levelUp = state.hand > 1 && (state.hand - 1) % rules.blindsEvery === 0;
    events.push({ type: 'hand', hand: state.hand, dealer: state.dealer, sb: state.sb, bb: state.bb, sbSeat, bbSeat, players: live, levelUp });
    log.push(`Hand ${state.hand}: blinds ${state.sb}/${state.bb}${levelUp ? ' (blinds up!)' : ''}, ${name(state.dealer)} deals`);
    state.needs = P.map((_, i) => canAct(i));
    // Pre-flop the player left of the big blind starts; heads-up the dealer (small blind) does.
    state.toAct = headsUp && canAct(state.dealer) ? state.dealer : nextFrom(headsUp ? state.dealer : bbSeat, canAct);
    advance(events, log, true);
  }

  // After an action: next player, next street, or the end of the hand.
  function advance(events, log, fresh = false) {
    const live = P.map((_, i) => i).filter(inHand);
    if (live.length === 1) { winUncontested(live[0], events, log); return; }
    if (!fresh) {
      const next = nextFrom(state.toAct, (j) => state.needs[j] && canAct(j));
      if (next !== -1) { state.toAct = next; return; }
    } else if (state.toAct !== -1 && (live.filter(canAct).length > 1 || state.currentBet > P[state.toAct].bet)) {
      return; // betting starts (or the only player left to act still has to call an all-in blind)
    }
    // Betting round complete.
    for (const p of P) p.bet = 0;
    state.currentBet = 0;
    state.minRaise = state.bb;
    if (state.street === 'river') { showdown(events, log); return; }
    const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[state.street];
    const count = next === 'flop' ? 3 : 1;
    state.deck.pop(); // burn
    const cards = [];
    for (let k = 0; k < count; k++) cards.push(state.deck.pop());
    state.board.push(...cards);
    state.street = next;
    events.push({ type: 'board', street: next, cards, board: [...state.board] });
    log.push(`${next[0].toUpperCase()}${next.slice(1)}: ${cards.map(cardText).join(' ')}`);
    state.needs = P.map((_, i) => canAct(i));
    if (live.filter(canAct).length <= 1) {
      // Everyone (but at most one) is all-in: deal the rest without betting.
      state.toAct = -1;
      state.needs.fill(false);
      advance(events, log, true);
      return;
    }
    state.toAct = nextFrom(state.dealer, (j) => state.needs[j] && canAct(j));
  }

  function winUncontested(i, events, log) {
    const amount = pot();
    P[i].chips += amount;
    events.push({ type: 'win', pots: [{ amount, winners: [i], hand: null }], uncontested: true });
    log.push(`${name(i)} wins ${amount} (everyone else folded)`);
    state.lastResult = { hand: state.hand, pots: [{ amount, winners: [i], hand: null }], shown: [] };
    endHand(events, log);
  }

  // Splits the chips into the main pot and side pots and pays the best hands.
  function showdown(events, log) {
    const live = P.map((_, i) => i).filter(inHand);
    const hands = new Map(live.map((i) => [i, bestHand([...P[i].cards, ...state.board])]));
    for (const i of live) P[i].shown = true;
    const { pots: split, payout } = splitPots(P.map((p) => p.total), new Map(live.map((i) => [i, hands.get(i).score])), state.dealer);
    payout.forEach((amount, i) => { P[i].chips += amount; });
    const pots = split;
    const paid = split.map((pt) => ({ amount: pt.amount, winners: pt.winners, hand: hands.get(pt.winners[0]).name }));
    const shown = live.map((i) => ({ seat: i, cards: [...P[i].cards], hand: hands.get(i).name, best: hands.get(i).cards }));
    events.push({ type: 'showdown', board: [...state.board], shown, pots: paid });
    paid.forEach((pt, k) => {
      const who = pt.winners.map(name).join(' and ');
      log.push(`${who} ${pt.winners.length > 1 ? 'split' : 'wins'} ${pots.length > 1 ? (k === 0 ? 'the main pot' : 'a side pot') + ' of ' : ''}${pt.amount} with ${pt.hand}`);
    });
    state.lastResult = { hand: state.hand, pots: paid, shown };
    endHand(events, log);
  }

  function endHand(events, log) {
    // Busted players are out; the one who started the hand with fewer chips goes out first.
    const busted = P.map((_, i) => i).filter((i) => !P[i].out && P[i].chips === 0);
    busted.sort((a, b) => P[a].total - P[b].total);
    for (const i of busted) {
      P[i].out = true;
      state.eliminated.push(i);
      events.push({ type: 'out', seat: i, place: alive().length + 1 });
      log.push(`${name(i)} is out`);
    }
    state.toAct = -1;
    startHand(events, log);
  }

  function finishGame(events, log) {
    state.over = true;
    state.toAct = -1;
    const winner = alive()[0];
    events.push({ type: 'gameover', winner });
    log.push(`${name(winner)} wins the tournament!`);
  }

  // ── decisions ──

  function amounts() {
    const i = state.toAct;
    const p = P[i];
    const toCall = Math.max(0, state.currentBet - p.bet);
    const stack = p.chips + p.bet;            // most this player can have in front of them
    const minTo = state.currentBet === 0 ? state.bb : state.currentBet + state.minRaise;
    const halfTo = state.currentBet + Math.max(state.minRaise, Math.floor((pot() + toCall) / 2));
    const othersCanAct = P.some((_, j) => j !== i && canAct(j));
    return { toCall, stack, minTo, halfTo, othersCanAct };
  }

  function decision() {
    if (state.over || state.toAct < 0) return null;
    const i = state.toAct;
    const p = P[i];
    const { toCall, stack, minTo, halfTo, othersCanAct } = amounts();
    const bet = state.currentBet === 0;
    const callAll = toCall >= p.chips;
    const canRaise = othersCanAct && stack > state.currentBet;
    const street = state.street === 'preflop' ? 'Pre-flop' : state.street[0].toUpperCase() + state.street.slice(1);
    return {
      seat: i,
      kind: 'bet',
      layout: 'list',
      hint: 'Tap your move below',
      prompt: `${street} · pot ${pot()} · ${toCall ? `${Math.min(toCall, p.chips)} to call` : 'nothing to call'} · you have ${p.chips}`,
      options: [
        { label: 'Fold', alias: 'fold', disabled: toCall === 0 },
        { label: toCall === 0 ? 'Check' : callAll ? `Call ${p.chips} (all-in)` : `Call ${toCall}`, alias: 'call' },
        { label: bet ? `Bet ${minTo}` : `Raise to ${minTo}`, alias: 'raise', disabled: !canRaise || minTo >= stack },
        { label: `${bet ? 'Bet' : 'Raise to'} ${halfTo} (½ pot)`, alias: 'pot', disabled: !canRaise || halfTo >= stack || halfTo <= minTo },
        // When nobody else can answer a raise, calling (option 2) is the only way to put chips in.
        { label: `All-in (${stack})`, alias: 'allin', disabled: !canRaise },
      ],
    };
  }

  function raiseTo(i, target, events, log, label) {
    const p = P[i];
    const before = state.currentBet;
    put(i, target - p.bet);
    const now = p.bet;
    if (now > before) {
      if (now - before >= state.minRaise) state.minRaise = now - before;
      state.currentBet = now;
      // Everyone else still in has to answer the raise.
      P.forEach((_, j) => { if (j !== i && canAct(j)) state.needs[j] = true; });
    }
    events.push({ type: 'bet', seat: i, action: label, to: now, chips: p.chips, allIn: p.allIn });
    log.push(`${label === 'allin' ? `goes all-in (${now})` : before === 0 ? `bets ${now}` : `raises to ${now}`}`);
  }

  function apply(index) {
    const d = decision();
    if (!d || !d.options[index] || d.options[index].disabled) throw new Error('not a legal choice');
    const i = state.toAct;
    const p = P[i];
    const events = [];
    const log = [];
    const { toCall, minTo, halfTo, stack } = amounts();
    if (index === FOLD) {
      p.folded = true;
      events.push({ type: 'fold', seat: i });
      log.push('folds');
    } else if (index === CALL) {
      const paid = put(i, toCall);
      events.push({ type: 'bet', seat: i, action: paid ? 'call' : 'check', to: p.bet, chips: p.chips, allIn: p.allIn });
      log.push(paid ? `calls ${paid}${p.allIn ? ' (all-in)' : ''}` : 'checks');
    } else if (index === RAISE) {
      raiseTo(i, minTo, events, log, 'raise');
    } else if (index === HALF_POT) {
      raiseTo(i, halfTo, events, log, 'raise');
    } else if (index === ALL_IN) {
      raiseTo(i, stack, events, log, 'allin');
    }
    state.needs[i] = false;
    advance(events, log);
    return { events, log };
  }

  // Chat shortcuts: !fold, !check / !call, !raise / !bet, !pot, !allin / !shove.
  function command(alias) {
    const map = { fold: FOLD, check: CALL, call: CALL, raise: RAISE, bet: RAISE, pot: HALF_POT, allin: ALL_IN, shove: ALL_IN };
    return map[alias] ?? -1;
  }

  // Time ran out: check if that's free, otherwise fold.
  function timeoutChoice() {
    if (state.toAct < 0) return undefined;
    return amounts().toCall === 0 ? CALL : FOLD;
  }

  // ── bots ──
  // Monte Carlo: deal random opponent hands and the rest of the board many times and count how
  // often our hand wins. Uses its own little generator (seeded from the situation), not the game
  // RNG, so a bot thinking never changes the cards that come next.
  function equity(i, sims = 260) {
    let seed = (state.hand * 7919 + i * 104729 + state.board.length * 1299709 + P[i].cards[0] * 31) >>> 0;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const known = new Set([...P[i].cards, ...state.board]);
    const unknown = Array.from({ length: 52 }, (_, c) => c).filter((c) => !known.has(c));
    const opponents = P.filter((_, j) => j !== i && inHand(j)).length;
    let score = 0;
    for (let s = 0; s < sims; s++) {
      const deck = unknown.slice();
      const draw = () => deck.splice(Math.floor(rand() * deck.length), 1)[0];
      const board = [...state.board];
      while (board.length < 5) board.push(draw());
      const mine = bestHand([...P[i].cards, ...board]).score;
      let result = 1;
      for (let o = 0; o < opponents && result > 0; o++) {
        const theirs = bestHand([draw(), draw(), ...board]).score;
        const c = compareScores(mine, theirs);
        if (c < 0) result = 0; else if (c === 0) result = Math.min(result, 0.5);
      }
      score += result;
    }
    return score / sims;
  }

  function botChoice() {
    const d = decision();
    if (!d) return 0;
    const i = state.toAct;
    const p = P[i];
    const ok = (k) => !d.options[k].disabled;
    const { toCall } = amounts();
    const e = equity(i);
    const odds = toCall / (pot() + toCall || 1);
    // a little personality: same situation, same mood (deterministic)
    const mood = ((state.hand * 31 + i * 17 + state.board.length * 7 + p.cards[1]) % 100) / 100;
    const shortStack = p.chips <= state.bb * 4;
    if (toCall === 0) {
      if (e > 0.72 && ok(HALF_POT)) return HALF_POT;
      if (e > 0.6 && ok(RAISE)) return RAISE;
      if (mood < 0.08 && ok(RAISE)) return RAISE; // the odd bluff
      return CALL;
    }
    if (e > 0.82 && ok(ALL_IN) && (shortStack || mood < 0.4)) return ALL_IN;
    if (e > 0.7 && ok(HALF_POT) && mood < 0.6) return HALF_POT;
    if (e > 0.62 && ok(RAISE) && mood < 0.35) return RAISE;
    if (e >= odds + 0.04 || (shortStack && e > 0.4)) return CALL;
    if (mood < 0.04 && ok(RAISE)) return RAISE;
    return FOLD;
  }

  function ranking() {
    const standing = alive().sort((a, b) => P[b].chips - P[a].chips);
    return [...standing, ...[...state.eliminated].reverse()];
  }

  // What one seat may see (seat = null: the public view for the stream / spectators).
  function viewFor(seat = null) {
    return {
      rules,
      hand: state.hand,
      sb: state.sb,
      bb: state.bb,
      level: state.level,
      dealer: state.dealer,
      street: state.street,
      board: [...state.board],
      pot: pot(),
      toAct: state.toAct,
      currentBet: state.currentBet,
      over: state.over,
      you: seat,
      lastResult: state.lastResult,
      players: P.map((p, i) => ({
        chips: p.chips,
        bet: p.bet,
        total: p.total,
        folded: p.folded,
        allIn: p.allIn,
        out: p.out,
        // -1 = a card face down
        cards: p.cards.length === 0 ? [] : (i === seat || p.shown) ? [...p.cards] : p.cards.map(() => -1),
        hand: (i === seat || p.shown) && p.cards.length ? holeName(p.cards, state.board) : null,
      })),
    };
  }

  startHand([], []); // deal the first hand

  return { state, decision, apply, command, botChoice, timeoutChoice, ranking, isDraw: () => false, viewFor, equity };
}

// Main pot and side pots. totals[i] = chips seat i put in this hand (folded seats too);
// scores: Map seat → hand score for the seats still in (eligible to win). Odd chips go to the first
// winners left of the dealer. Returns { pots: [{ amount, eligible, winners }], payout: chips per seat }.
export function splitPots(totals, scores, dealer) {
  const n = totals.length;
  const live = [...scores.keys()];
  const levels = [...new Set(live.map((i) => totals[i]))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const t of totals) amount += Math.min(t, level) - Math.min(t, prev);
    if (amount > 0) pots.push({ amount, eligible: live.filter((i) => totals[i] >= level) });
    prev = level;
  }
  // Chips folded players put in above the highest stack still in go to the last pot.
  const extra = totals.reduce((s, t) => s + Math.max(0, t - prev), 0);
  if (extra && pots.length) pots[pots.length - 1].amount += extra;
  const payout = new Array(n).fill(0);
  for (const pt of pots) {
    let best = null;
    let winners = [];
    for (const i of pt.eligible) {
      const c = best ? compareScores(scores.get(i), best) : 1;
      if (c > 0) { best = scores.get(i); winners = [i]; } else if (c === 0) winners.push(i);
    }
    winners.sort((a, b) => ((a - dealer - 1 + n) % n) - ((b - dealer - 1 + n) % n));
    const share = Math.floor(pt.amount / winners.length);
    let rest = pt.amount - share * winners.length;
    for (const w of winners) { payout[w] += share + (rest > 0 ? 1 : 0); rest -= 1; }
    pt.winners = winners;
  }
  return { pots, payout };
}

// What a player holds right now, in words: "Pair of Aces" before the flop, the best hand after.
export function holeName(cards, board) {
  if (board.length >= 3) return bestHand([...cards, ...board]).name;
  const [a, b] = cards.map(rankOf).sort((x, y) => y - x);
  const R = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
  const S = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return a === b ? `Pair of ${R[a]}` : `${S[a]}-${S[b]}${cards[0] % 13 !== cards[1] % 13 && Math.floor(cards[0] / 13) === Math.floor(cards[1] / 13) ? ' suited' : ''}`;
}

// What the streamer dock shows for the player of `view` (a viewFor(seat) result): their own cards,
// the board and the numbers that matter. Plain data; the dock draws it (app/dock/).
export function privateSummary(view) {
  const me = view.players?.[view.you];
  if (!me) return null;
  const card = (c) => ({ text: cardText(c), red: Math.floor(c / 13) === 1 || Math.floor(c / 13) === 2 });
  const toCall = Math.max(0, Math.min(view.currentBet - me.bet, me.chips));
  const street = view.street === 'preflop' ? 'Pre-flop' : view.street[0].toUpperCase() + view.street.slice(1);
  return {
    title: me.out ? 'You are out' : me.folded ? 'You folded' : me.hand ?? 'Your cards',
    cards: me.cards.filter((c) => c >= 0).map(card),
    board: view.board.map(card),
    facts: [
      ['Chips', me.chips],
      ['Pot', view.pot],
      ['To call', toCall],
      ['Blinds', `${view.sb}/${view.bb}`],
      ['Hand', `#${view.hand} · ${street}`],
    ],
  };
}
