// Neon Chess — the board game around the chess rules in engine.js.
//
// Every turn is numbered decisions, like every other game here:
//   1. pick a piece  — the pieces that can move get numbers on the board (!1 … !16)
//   2. pick a square — numbered target squares, plus "back" to pick another piece
//   3. (promotion)   — which piece the Street Runner becomes
// Moves can also be typed in one go: !e4, !Nf3, !exd5, !O-O, !e2e4, !e7e8q (game.command).
// Every legal move is also a hidden option, so bots, typed moves and chat votes all end up as
// one option index, and taps on a phone use the same numbers.
//
// Clocks (rules.clockMinutes > 0): each side has its own time; the Session tells apply() how
// long the decision took (elapsedMs), and the decision's timer is that side's remaining time —
// when it runs out, timeoutChoice() is "out of time" (a loss, or a draw if the other side
// can't mate). Without a clock each step has rules.moveSeconds and a timeout lets the bot move.

import {
  fromFen, legalMoves, makeMove, toSan, parseMove, positionKey, inCheck, insufficientMaterial,
  botMove, sqName, typeOf, colorOf, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, START_FEN,
} from './engine.js';

export const DEFAULT_RULES = {
  clockMinutes: 5,   // per side; 0 = no clock
  increment: 0,      // seconds added after each move
  moveSeconds: 90,   // per step when there is no clock (0 = the Session's default turn time)
  botLevel: 2,       // 1 casual … 4 strong
  maxPlies: 300,     // stream safety net: draw after 150 moves each
  fen: START_FEN,
};

// The cyberpunk names, by piece type.
export const PIECE_NAMES = { [PAWN]: 'Runner', [KNIGHT]: 'Jetpack', [BISHOP]: 'Technomancer', [ROOK]: 'Mech', [QUEEN]: 'Assassin', [KING]: 'Overlord' };
const PROMO_ORDER = [QUEEN, ROOK, BISHOP, KNIGHT];
const ORDER = [KING, QUEEN, ROOK, BISHOP, KNIGHT, PAWN]; // how pieces are numbered in step 1

export function createGame({ seats, rng, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const P0 = fromFen(R.fen);
  const s = {
    seats: [...seats],
    P: P0,
    step: 'piece',      // 'piece' | 'target' | 'promo'
    sel: -1,            // selected square (step 2, 3)
    promoTo: -1,        // target square (step 3)
    sans: [],           // the game so far in algebraic notation
    keys: { [positionKey(P0)]: 1 },
    plies: 0,
    lastMove: null,     // { from, to }
    captured: [[], []], // piece types each side has taken
    clock: R.clockMinutes > 0 ? [R.clockMinutes * 60000, R.clockMinutes * 60000] : null,
    check: inCheck(P0),
    over: false,
    winner: null,
    result: null,       // 'checkmate' | 'resign' | 'time' | 'stalemate' | 'repetition' | 'fifty' | 'material' | 'length'
  };
  let legalCache = null;
  const legal = () => {
    if (legalCache?.P !== s.P) legalCache = { P: s.P, moves: legalMoves(s.P) };
    return legalCache.moves;
  };
  const name = (seat) => s.seats[seat][0].toUpperCase() + s.seats[seat].slice(1);
  const pieceName = (pc) => PIECE_NAMES[typeOf(pc)];

  // Option list: [visible step options …, every legal move (hidden), resign (hidden), out of time (hidden)]
  function build() {
    const moves = legal();
    const visible = [];
    if (s.step === 'piece') {
      const froms = [...new Set(moves.map((m) => m.from))];
      froms.sort((a, b) => ORDER.indexOf(typeOf(s.P.b[a])) - ORDER.indexOf(typeOf(s.P.b[b])) || (a & 7) - (b & 7) || (a >> 3) - (b >> 3));
      for (const from of froms) visible.push({ label: `${pieceName(s.P.b[from])} ${sqName(from)}`, data: { kind: 'piece', from } });
    } else if (s.step === 'target') {
      const tos = [...new Set(moves.filter((m) => m.from === s.sel).map((m) => m.to))];
      tos.sort((a, b) => (a >> 3) - (b >> 3) || (a & 7) - (b & 7));
      for (const to of tos) {
        const m = moves.find((x) => x.from === s.sel && x.to === to);
        visible.push({ label: m.captured ? `${sqName(to)} — takes the ${pieceName(m.captured)}` : sqName(to), data: { kind: 'target', to } });
      }
      visible.push({ label: 'Back — pick another piece', alias: 'back', data: { kind: 'back' } });
    } else {
      for (const t of PROMO_ORDER) visible.push({ label: PIECE_NAMES[t], data: { kind: 'promo', type: t } });
    }
    const hidden = moves.map((m, i) => ({ label: m.san ?? '', hidden: true, data: { kind: 'move', i } }));
    return [...visible, ...hidden,
      { label: 'Resign', hidden: true, data: { kind: 'resign' } },
      { label: 'Out of time', hidden: true, data: { kind: 'flag' } }];
  }
  const firstHidden = () => build().findIndex((o) => o.hidden);
  // (moves from engine functions are new objects: match them by squares)
  const moveIndex = (m) => {
    const i = legal().findIndex((x) => x.from === m.from && x.to === m.to && x.promo === m.promo);
    return i < 0 ? -1 : firstHidden() + i;
  };

  function decision() {
    if (s.over) return null;
    const seat = s.P.turn;
    const options = build();
    const count = options.filter((o) => !o.hidden).length;
    const who = name(seat);
    const prompt = s.step === 'piece' ? `${who}${s.check ? ' (in check!)' : ''}: pick a piece !1–!${count}, or type a move like !e4`
      : s.step === 'target' ? `${who}: where does the ${pieceName(s.P.b[s.sel])} on ${sqName(s.sel)} go? !1–!${count - 1}, !${count} = back`
      : `${who}: your Runner reached the end — what does it become?`;
    return {
      seat,
      kind: 'choose',
      prompt,
      hint: s.step === 'piece' ? 'Tap a piece' : s.step === 'target' ? 'Tap a square' : 'Pick a piece',
      options,
      seconds: s.clock ? Math.max(0.5, s.clock[seat] / 1000) : (R.moveSeconds || undefined),
      step: s.step,
      selected: s.sel,
    };
  }

  function finish(result, winner, events, log, text) {
    s.over = true;
    s.result = result;
    s.winner = winner;
    events.push({ type: winner === null ? 'draw' : 'win', seat: winner, result });
    log.push(text);
  }

  // Can `seat` still checkmate with what it has? (Losing on time against a bare king is a draw.)
  function canMate(seat) {
    const own = s.P.b.filter((pc) => pc && colorOf(pc) === seat && typeOf(pc) !== KING).map(typeOf);
    return !(own.length === 0 || (own.length === 1 && (own[0] === KNIGHT || own[0] === BISHOP)));
  }

  function doMove(m, events, log) {
    const seat = s.P.turn;
    const san = toSan(s.P, m, legal());
    s.P = makeMove(s.P, m);
    s.plies++;
    s.sans.push(san);
    const key = positionKey(s.P);
    s.keys[key] = (s.keys[key] ?? 0) + 1;
    if (m.captured) s.captured[seat].push(typeOf(m.captured));
    s.lastMove = { from: m.from, to: m.to };
    s.check = inCheck(s.P);
    s.step = 'piece'; s.sel = -1; s.promoTo = -1;
    if (s.clock) s.clock[seat] += R.increment * 1000;
    const mate = s.check && legalMoves(s.P).length === 0;
    events.push({
      type: 'move', seat, san,
      from: m.from, to: m.to,
      piece: typeOf(m.piece), captured: m.captured ? typeOf(m.captured) : 0,
      capturedAt: m.ep ? m.to + (seat === 0 ? -8 : 8) : m.to,
      promo: m.promo,
      castle: m.castle ? { from: m.castle === 'k' ? m.to + 1 : m.to - 2, to: m.castle === 'k' ? m.to - 1 : m.to + 1 } : null,
      ep: m.ep,
      check: s.check, mate,
      kingAt: s.check ? s.P.b.indexOf((1 - seat) * 8 + KING) : -1,
    });
    log.push(`${name(seat)}: ${san}${m.captured ? ` — the ${PIECE_NAMES[typeOf(m.piece)]} takes the ${PIECE_NAMES[typeOf(m.captured)]}` : ''}`);
    const next = legalMoves(s.P);
    if (!next.length) {
      if (s.check) finish('checkmate', seat, events, log, `Checkmate! ${name(seat)} wins.`);
      else finish('stalemate', null, events, log, 'Stalemate — draw!');
    } else if (s.keys[key] >= 3) finish('repetition', null, events, log, 'The same position for the third time — draw!');
    else if (s.P.half >= 100) finish('fifty', null, events, log, 'Fifty moves without a capture or a Runner move — draw!');
    else if (insufficientMaterial(s.P.b)) finish('material', null, events, log, 'Nobody can checkmate any more — draw!');
    else if (s.plies >= R.maxPlies) finish('length', null, events, log, 'Move limit reached — draw!');
    else if (s.check) events.push({ type: 'check', seat: 1 - seat, at: s.P.b.indexOf((1 - seat) * 8 + KING) });
  }

  function apply(index, { elapsedMs = 0 } = {}) {
    const seat = s.P.turn;
    const options = build();
    const o = options[index];
    if (!o) throw new Error(`no option ${index + 1}`);
    const events = [];
    const log = [];
    if (s.clock) s.clock[seat] = Math.max(0, s.clock[seat] - Math.max(0, elapsedMs));
    const d = o.data;
    if (d.kind === 'flag' || (s.clock && s.clock[seat] <= 0)) {
      s.clock && (s.clock[seat] = 0);
      if (canMate(1 - seat)) finish('time', 1 - seat, events, log, `${name(seat)} ran out of time — ${name(1 - seat)} wins!`);
      else finish('time', null, events, log, `${name(seat)} ran out of time, but ${name(1 - seat)} can't checkmate — draw!`);
      return { events, log };
    }
    if (d.kind === 'resign') {
      finish('resign', 1 - seat, events, log, `${name(seat)} resigns — ${name(1 - seat)} wins!`);
      return { events, log };
    }
    if (d.kind === 'piece') {
      s.step = 'target'; s.sel = d.from;
      events.push({ type: 'select', seat, at: d.from, targets: legal().filter((m) => m.from === d.from).map((m) => m.to) });
    } else if (d.kind === 'back') {
      s.step = 'piece'; s.sel = -1;
      events.push({ type: 'deselect', seat });
    } else if (d.kind === 'target') {
      const ms = legal().filter((m) => m.from === s.sel && m.to === d.to);
      if (ms.some((m) => m.promo)) {
        s.step = 'promo'; s.promoTo = d.to;
        events.push({ type: 'promoting', seat, at: s.sel, to: d.to });
      } else doMove(ms[0], events, log);
    } else if (d.kind === 'promo') {
      doMove(legal().find((m) => m.from === s.sel && m.to === s.promoTo && m.promo === d.type), events, log);
    } else if (d.kind === 'move') {
      doMove(legal()[d.i], events, log);
    }
    return { events, log };
  }

  return {
    get state() { return s; },
    rules: R,
    decision,
    apply,

    // Typed moves: "!e4", "!Nf3", "!move e2e4", "!resign".
    command(alias, arg) {
      if (s.over) return -1;
      if (alias === 'resign') return build().findIndex((o) => o.data.kind === 'resign');
      const text = alias === 'move' || alias === 'm' ? arg : `${alias}${arg ?? ''}`;
      const m = parseMove(s.P, text, legal());
      return m ? moveIndex(m) : -1;
    },

    botChoice() {
      const ahead = (P) => s.keys[positionKey(P)] >= 2;
      const m = botMove(s.P, R.botLevel, () => rng.next(), { avoid: ahead });
      return moveIndex(m);
    },

    // With a clock, time running out is a loss; without one, the bot moves for the player.
    timeoutChoice() {
      if (s.clock) return build().findIndex((o) => o.data.kind === 'flag');
      return this.botChoice();
    },

    isDraw: () => s.over && s.winner === null,

    ranking() {
      if (s.winner === null) return [s.P.turn, 1 - s.P.turn];
      return [s.winner, 1 - s.winner];
    },
  };
}
