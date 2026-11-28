// Neon Chess — pure chess rules: positions, legal moves, check, mate, draws, notation, and a bot.
// No graphics, no timers; deterministic. games/chess/logic.js turns this into a board game for
// the Session (numbered decisions, chat commands, clocks).
//
// Squares 0–63: a1 = 0, b1 = 1 … h1 = 7, a2 = 8 … h8 = 63. Pieces are small numbers:
// colour * 8 + type, type 1 pawn · 2 knight · 3 bishop · 4 rook · 5 queen · 6 king;
// colour 0 = White (the cyan side, moves first), 1 = Black (magenta). 0 = empty.

export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const TYPE_CHAR = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
const CHAR_TYPE = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
export const typeOf = (pc) => pc & 7;
export const colorOf = (pc) => pc >> 3;
export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 3;
export const sqName = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 3) + 1);
export const sqFromName = (n) => (/^[a-h][1-8]$/.test(n) ? (n.charCodeAt(0) - 97) + (Number(n[1]) - 1) * 8 : -1);

// Castling rights bits.
const WK = 1, WQ = 2, BK = 4, BQ = 8;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Position: { b: number[64], turn, castle, ep (square or -1), half, full }
export function fromFen(fen = START_FEN) {
  const [rows, turn, castle, ep, half, full] = fen.trim().split(/\s+/);
  const b = new Array(64).fill(0);
  rows.split('/').forEach((row, i) => {
    let f = 0;
    const r = 7 - i;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const t = CHAR_TYPE[ch.toLowerCase()];
      b[r * 8 + f] = (ch === ch.toLowerCase() ? 8 : 0) + t;
      f++;
    }
  });
  let c = 0;
  if (castle.includes('K')) c |= WK;
  if (castle.includes('Q')) c |= WQ;
  if (castle.includes('k')) c |= BK;
  if (castle.includes('q')) c |= BQ;
  return { b, turn: turn === 'b' ? 1 : 0, castle: c, ep: ep && ep !== '-' ? sqFromName(ep) : -1, half: Number(half ?? 0), full: Number(full ?? 1) };
}

export function toFen(P) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const pc = P.b[r * 8 + f];
      if (!pc) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const ch = TYPE_CHAR[typeOf(pc)];
      row += colorOf(pc) ? ch : ch.toUpperCase();
    }
    rows.push(row + (empty || ''));
  }
  const c = (P.castle & WK ? 'K' : '') + (P.castle & WQ ? 'Q' : '') + (P.castle & BK ? 'k' : '') + (P.castle & BQ ? 'q' : '');
  return `${rows.join('/')} ${P.turn ? 'b' : 'w'} ${c || '-'} ${P.ep >= 0 ? sqName(P.ep) : '-'} ${P.half} ${P.full}`;
}

// The part of a position that counts for repetition: board, side to move, castling, en passant.
export function positionKey(P) { return toFen(P).split(' ').slice(0, 4).join(' '); }

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

const at = (f, r) => (f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f);

// Is square sq attacked by colour `by`?
export function attacked(b, sq, by) {
  const f = sq & 7, r = sq >> 3;
  const dir = by === 0 ? -1 : 1; // pawns of `by` attack from one rank behind (from sq's view)
  for (const df of [-1, 1]) {
    const s = at(f + df, r + dir);
    if (s >= 0 && b[s] === by * 8 + PAWN) return true;
  }
  for (const [df, dr] of KNIGHT_STEPS) {
    const s = at(f + df, r + dr);
    if (s >= 0 && b[s] === by * 8 + KNIGHT) return true;
  }
  for (const [df, dr] of KING_STEPS) {
    const s = at(f + df, r + dr);
    if (s >= 0 && b[s] === by * 8 + KING) return true;
  }
  for (const [dirs, a, c] of [[ROOK_DIRS, ROOK, QUEEN], [BISHOP_DIRS, BISHOP, QUEEN]]) {
    for (const [df, dr] of dirs) {
      let x = f + df, y = r + dr;
      while (x >= 0 && x < 8 && y >= 0 && y < 8) {
        const pc = b[y * 8 + x];
        if (pc) {
          if (pc === by * 8 + a || pc === by * 8 + c) return true;
          break;
        }
        x += df; y += dr;
      }
    }
  }
  return false;
}

export const kingSquare = (b, color) => b.indexOf(color * 8 + KING);
export const inCheck = (P, color = P.turn) => attacked(P.b, kingSquare(P.b, color), 1 - color);

// Move: { from, to, piece, captured, promo (type or 0), ep (true when en passant), castle ('k'|'q'|null) }
function pseudoMoves(P) {
  const { b, turn } = P;
  const out = [];
  const add = (from, to, extra = {}) => out.push({ from, to, piece: b[from], captured: b[to], promo: 0, ep: false, castle: null, ...extra });
  for (let from = 0; from < 64; from++) {
    const pc = b[from];
    if (!pc || colorOf(pc) !== turn) continue;
    const t = typeOf(pc), f = from & 7, r = from >> 3;
    if (t === PAWN) {
      const dir = turn === 0 ? 1 : -1, startRank = turn === 0 ? 1 : 6, lastRank = turn === 0 ? 7 : 0;
      const pushes = (to, extra = {}) => {
        if ((to >> 3) === lastRank) for (const p of [QUEEN, ROOK, BISHOP, KNIGHT]) add(from, to, { ...extra, promo: p });
        else add(from, to, extra);
      };
      const one = at(f, r + dir);
      if (one >= 0 && !b[one]) {
        pushes(one);
        const two = at(f, r + 2 * dir);
        if (r === startRank && !b[two]) add(from, two);
      }
      for (const df of [-1, 1]) {
        const to = at(f + df, r + dir);
        if (to < 0) continue;
        if (b[to] && colorOf(b[to]) !== turn) pushes(to);
        else if (to === P.ep) add(from, to, { ep: true, captured: (1 - turn) * 8 + PAWN });
      }
    } else if (t === KNIGHT || t === KING) {
      for (const [df, dr] of t === KNIGHT ? KNIGHT_STEPS : KING_STEPS) {
        const to = at(f + df, r + dr);
        if (to >= 0 && (!b[to] || colorOf(b[to]) !== turn)) add(from, to);
      }
      if (t === KING) {
        const home = turn === 0 ? 4 : 60;
        const [kBit, qBit] = turn === 0 ? [WK, WQ] : [BK, BQ];
        if (from === home && !attacked(b, home, 1 - turn)) {
          if (P.castle & kBit && !b[home + 1] && !b[home + 2] && b[home + 3] === turn * 8 + ROOK
            && !attacked(b, home + 1, 1 - turn) && !attacked(b, home + 2, 1 - turn)) add(from, home + 2, { castle: 'k' });
          if (P.castle & qBit && !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === turn * 8 + ROOK
            && !attacked(b, home - 1, 1 - turn) && !attacked(b, home - 2, 1 - turn)) add(from, home - 2, { castle: 'q' });
        }
      }
    } else {
      const dirs = t === ROOK ? ROOK_DIRS : t === BISHOP ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const to = y * 8 + x;
          if (b[to]) { if (colorOf(b[to]) !== turn) add(from, to); break; }
          add(from, to);
          x += df; y += dr;
        }
      }
    }
  }
  return out;
}

export function makeMove(P, m) {
  const b = P.b.slice();
  const turn = P.turn;
  b[m.to] = m.promo ? turn * 8 + m.promo : m.piece;
  b[m.from] = 0;
  if (m.ep) b[m.to + (turn === 0 ? -8 : 8)] = 0;
  if (m.castle === 'k') { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = 0; }
  if (m.castle === 'q') { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = 0; }
  let castle = P.castle;
  for (const sq of [m.from, m.to]) {
    if (sq === 4) castle &= ~(WK | WQ);
    if (sq === 60) castle &= ~(BK | BQ);
    if (sq === 7) castle &= ~WK;
    if (sq === 0) castle &= ~WQ;
    if (sq === 63) castle &= ~BK;
    if (sq === 56) castle &= ~BQ;
  }
  const t = typeOf(m.piece);
  return {
    b, turn: 1 - turn, castle,
    ep: t === PAWN && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : -1,
    half: t === PAWN || m.captured ? 0 : P.half + 1,
    full: P.full + (turn === 1 ? 1 : 0),
  };
}

export function legalMoves(P) {
  return pseudoMoves(P).filter((m) => !inCheck(makeMove(P, m), P.turn));
}

// Not enough pieces left for anyone to mate: K v K, K+minor v K, K+B v K+B with same-colour bishops.
export function insufficientMaterial(b) {
  const pieces = [];
  for (let sq = 0; sq < 64; sq++) if (b[sq] && typeOf(b[sq]) !== KING) pieces.push([typeOf(b[sq]), sq]);
  if (pieces.length === 0) return true;
  if (pieces.length === 1) return pieces[0][0] === KNIGHT || pieces[0][0] === BISHOP;
  if (pieces.every(([t]) => t === BISHOP)) {
    const shade = (sq) => ((sq & 7) + (sq >> 3)) % 2;
    return pieces.every(([, sq]) => shade(sq) === shade(pieces[0][1]));
  }
  return false;
}

// Standard algebraic notation (SAN) of a legal move in position P, with + / #.
export function toSan(P, m, legal = legalMoves(P)) {
  let san;
  if (m.castle) san = m.castle === 'k' ? 'O-O' : 'O-O-O';
  else {
    const t = typeOf(m.piece);
    const cap = m.captured ? 'x' : '';
    if (t === PAWN) san = (cap ? 'abcdefgh'[m.from & 7] + 'x' : '') + sqName(m.to) + (m.promo ? `=${TYPE_CHAR[m.promo].toUpperCase()}` : '');
    else {
      const rivals = legal.filter((o) => o.to === m.to && o.piece === m.piece && o.from !== m.from);
      let dis = '';
      if (rivals.length) {
        if (!rivals.some((o) => (o.from & 7) === (m.from & 7))) dis = 'abcdefgh'[m.from & 7];
        else if (!rivals.some((o) => (o.from >> 3) === (m.from >> 3))) dis = String((m.from >> 3) + 1);
        else dis = sqName(m.from);
      }
      san = TYPE_CHAR[t].toUpperCase() + dis + cap + sqName(m.to);
    }
  }
  const next = makeMove(P, m);
  if (inCheck(next)) san += legalMoves(next).length ? '+' : '#';
  return san;
}

// Parses what someone typed — "e4", "Nf3", "exd5", "O-O", "e2e4", "e7e8q", "Qxd5+" — in any
// case (chat commands arrive lowercased). Returns the matching legal move or null.
// Lowercase "bc4" could be a bishop or the b-pawn: a unique legal reading wins, the bishop first.
export function parseMove(P, text, legal = legalMoves(P)) {
  let t = String(text ?? '').trim().replace(/[+#!?]+$/, '').replace(/\s+/g, '');
  if (!t) return null;
  if (/^(o-o-o|0-0-0|ooo)$/i.test(t)) return legal.find((m) => m.castle === 'q') ?? null;
  if (/^(o-o|0-0|oo)$/i.test(t)) return legal.find((m) => m.castle === 'k') ?? null;
  const lc = t.toLowerCase().replace(/[-=]/g, '');
  // Coordinates: e2e4, e7e8q, e2-e4
  const coord = /^([a-h][1-8])x?([a-h][1-8])([qrbn])?$/.exec(lc);
  if (coord) {
    const from = sqFromName(coord[1]), to = sqFromName(coord[2]);
    const promo = coord[3] ? CHAR_TYPE[coord[3]] : 0;
    const hit = legal.filter((m) => m.from === from && m.to === to && (m.promo === promo || (!promo && m.promo === QUEEN)));
    if (hit.length) return hit[0];
  }
  const san = /^([nbrqk])?([a-h])?([1-8])?x?([a-h][1-8])([qrbn])?$/.exec(lc);
  if (!san) return null;
  const [, pieceCh, ff, rr, dest, promoCh] = san;
  const to = sqFromName(dest);
  const promo = promoCh ? CHAR_TYPE[promoCh] : 0;
  const fits = (type, file, rank) => legal.filter((m) => m.to === to && typeOf(m.piece) === type
    && (file === undefined || (m.from & 7) === file.charCodeAt(0) - 97)
    && (rank === undefined || (m.from >> 3) === Number(rank) - 1)
    && (type !== PAWN || m.promo === (promo || (m.promo ? QUEEN : 0))));
  const readings = [];
  if (pieceCh) readings.push(fits(CHAR_TYPE[pieceCh], ff, rr));
  // "b" may also have been a pawn on the b-file ("bxc4", "bc4" lowercased)
  if (pieceCh === 'b' && !ff) readings.push(fits(PAWN, 'b', rr));
  if (!pieceCh) readings.push(fits(PAWN, ff, rr));
  for (const r of readings) if (r.length === 1) return r[0];
  return null;
}

// ───────────────────────────── bot ─────────────────────────────
// Negamax with alpha-beta, captures-first ordering, a short capture search at the leaves and
// piece-square tables. Level 1 (casual) … 4 (strong); lower levels also slip now and then.

const VALUE = [0, 100, 320, 330, 500, 900, 0];
// Piece-square tables from White's view, a1 first (index = square).
const PST = {
  [PAWN]: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, -20, -20, 10, 10, 5, 5, -5, -10, 0, 0, -10, -5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, 5, 10, 25, 25, 10, 5, 5, 10, 10, 20, 30, 30, 20, 10, 10, 50, 50, 50, 50, 50, 50, 50, 50, 0, 0, 0, 0, 0, 0, 0, 0],
  [KNIGHT]: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 5, 5, 0, -20, -40, -30, 5, 10, 15, 15, 10, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 10, 15, 15, 10, 0, -30, -40, -20, 0, 0, 0, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  [BISHOP]: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 5, 0, 0, 0, 0, 5, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  [ROOK]: [0, 0, 0, 5, 5, 0, 0, 0, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 5, 10, 10, 10, 10, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  [QUEEN]: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 5, 0, 0, 0, 0, -10, -10, 5, 5, 5, 5, 5, 0, -10, 0, 0, 5, 5, 5, 5, 0, -5, -5, 0, 5, 5, 5, 5, 0, -5, -10, 0, 5, 5, 5, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  [KING]: [20, 30, 10, 0, 0, 10, 30, 20, 20, 20, 0, 0, 0, 0, 20, 20, -10, -20, -20, -20, -20, -20, -20, -10, -20, -30, -30, -40, -40, -30, -30, -20, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30],
};
const KING_END = [-50, -30, -30, -30, -30, -30, -30, -50, -30, -30, 0, 0, 0, 0, -30, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -20, -10, 0, 0, -10, -20, -30, -50, -40, -30, -20, -20, -30, -40, -50];

// Score from the side to move's point of view.
export function evaluate(P) {
  let score = 0, material = 0;
  for (let sq = 0; sq < 64; sq++) { const pc = P.b[sq]; if (pc && typeOf(pc) !== KING && typeOf(pc) !== PAWN) material += VALUE[typeOf(pc)]; }
  const endgame = material <= 1300;
  for (let sq = 0; sq < 64; sq++) {
    const pc = P.b[sq];
    if (!pc) continue;
    const t = typeOf(pc), c = colorOf(pc);
    const idx = c === 0 ? sq : (7 - (sq >> 3)) * 8 + (sq & 7);
    const v = VALUE[t] + (t === KING && endgame ? KING_END[idx] : PST[t][idx]);
    score += c === 0 ? v : -v;
  }
  return P.turn === 0 ? score : -score;
}

const MATE = 100000;
const orderMoves = (moves) => moves.sort((a, b) => (b.captured ? VALUE[typeOf(b.captured)] * 10 - VALUE[typeOf(b.piece)] : 0) + (b.promo ? 800 : 0)
  - ((a.captured ? VALUE[typeOf(a.captured)] * 10 - VALUE[typeOf(a.piece)] : 0) + (a.promo ? 800 : 0)));

function quiesce(P, alpha, beta, depth, budget) {
  const stand = evaluate(P);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (depth <= 0 || budget.nodes-- <= 0) return alpha;
  for (const m of orderMoves(legalMoves(P).filter((x) => x.captured || x.promo))) {
    const score = -quiesce(makeMove(P, m), -beta, -alpha, depth - 1, budget);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(P, depth, alpha, beta, ply, budget) {
  const moves = legalMoves(P);
  if (!moves.length) return inCheck(P) ? -MATE + ply : 0;
  if (P.half >= 100) return 0;
  if (depth === 0) return quiesce(P, alpha, beta, 4, budget);
  for (const m of orderMoves(moves)) {
    const score = -negamax(makeMove(P, m), depth - 1, -beta, -alpha, ply + 1, budget);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
    if (budget.nodes <= 0) break;
  }
  return alpha;
}

// rand(): a number in [0, 1). Returns a legal move.
export function botMove(P, level = 2, rand = Math.random, { avoid = () => false } = {}) {
  const moves = orderMoves(legalMoves(P));
  if (moves.length <= 1) return moves[0] ?? null;
  const depth = [1, 1, 2, 3, 3][Math.max(1, Math.min(4, level))];
  const budget = { nodes: [0, 4000, 20000, 60000, 140000][Math.max(1, Math.min(4, level))] };
  const scored = moves.map((m) => {
    const next = makeMove(P, m);
    let s = -negamax(next, depth - 1, -MATE - 1, MATE + 1, 1, budget);
    if (avoid(next)) s -= 50; // e.g. a repetition when ahead
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  // Casual levels: sometimes pick among the near-best moves.
  const slack = [0, 120, 45, 12, 0][Math.max(1, Math.min(4, level))];
  const near = scored.filter((x) => x.s >= scored[0].s - slack && Math.abs(scored[0].s) < MATE / 2);
  if (slack && near.length > 1) return near[Math.floor(rand() * near.length)].m;
  return scored[0].m;
}
