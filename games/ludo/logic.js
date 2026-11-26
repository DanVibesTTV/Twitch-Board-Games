// Ludo rules — pure logic, no graphics. Implements the Game API (docs/GAME_API.md).
//
// Pawn progress per color:  -1 = yard,  0..50 = main track (relative to own start),
//                          51..55 = home column,  56 = finished (center).

export const TRACK_LEN = 52;
export const LAST_TRACK = 50;
export const FINISH = 56;
export const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
export const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]); // starts + stars (absolute)

export const DEFAULT_RULES = {
  sixExtraTurn: true,       // rolling a 6 gives another roll
  tripleSixForfeit: true,   // third 6 in a row ends the turn
  threeTriesWhenStuck: true, // nothing on the board → up to 3 rolls to get a 6 (Mensch-style)
  safeSquares: true,        // starts & stars protect pawns
  captureBonus: false,      // capturing grants an extra roll
  pawnsPerPlayer: 4,
};

const NAMES = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };

export function absSquare(color, progress) {
  return (START_OFFSET[color] + progress) % TRACK_LEN;
}

export function createGame({ seats, rng, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const s = {
    seats: [...seats],                                   // color ids, in turn order
    pawns: seats.map(() => new Array(R.pawnsPerPlayer).fill(-1)),
    current: 0,
    phase: 'roll',                                       // 'roll' | 'move' | 'over'
    roll: null,
    sixes: 0,
    tries: 0,
    moves: [],
    finished: [],                                        // game seat indices in finishing order
  };

  const color = (seat) => s.seats[seat];
  const name = (seat) => NAMES[color(seat)] ?? color(seat);
  const isDone = (seat) => s.pawns[seat].every((p) => p === FINISH);

  function legalMoves(seat, roll) {
    const moves = [];
    const seen = new Set();
    s.pawns[seat].forEach((p, pawn) => {
      let to;
      if (p === -1) { if (roll !== 6) return; to = 0; }
      else if (p === FINISH) return;
      else { to = p + roll; if (to > FINISH) return; }
      const key = `${p}>${to}`; // two pawns on the same spot → same move, list once
      if (seen.has(key)) return;
      seen.add(key);
      moves.push({ pawn, from: p, to, captures: capturesAt(seat, to) });
    });
    return moves;
  }

  function capturesAt(seat, to) {
    if (to < 0 || to > LAST_TRACK) return [];
    const sq = absSquare(color(seat), to);
    if (R.safeSquares && SAFE_SQUARES.has(sq)) return [];
    const hits = [];
    s.pawns.forEach((pawns, other) => {
      if (other === seat) return;
      pawns.forEach((p, pawn) => {
        if (p >= 0 && p <= LAST_TRACK && absSquare(color(other), p) === sq) hits.push({ seat: other, pawn });
      });
    });
    return hits;
  }

  // How many opponent pawns could hit this square next turn (1–6 behind it).
  function danger(seat, to) {
    if (to < 0 || to > LAST_TRACK) return 0;
    const sq = absSquare(color(seat), to);
    if (R.safeSquares && SAFE_SQUARES.has(sq)) return 0;
    let n = 0;
    s.pawns.forEach((pawns, other) => {
      if (other === seat) return;
      for (const p of pawns) {
        if (p < 0 || p > LAST_TRACK) continue;
        const dist = (sq - absSquare(color(other), p) + TRACK_LEN) % TRACK_LEN;
        if (dist >= 1 && dist <= 6) n++;
      }
    });
    return n;
  }

  function label(m) {
    const n = `Pawn ${m.pawn + 1}`;
    let text;
    if (m.from === -1) text = `${n}: out onto start`;
    else if (m.to === FINISH) text = `${n}: reach home 🏁`;
    else if (m.to > LAST_TRACK) text = `${n}: into home lane`;
    else text = `${n}: ${m.from} → ${m.to}`;
    if (m.captures.length) text += ` ⚔ ${m.captures.map((c) => name(c.seat)).join(', ')}`;
    return text;
  }

  function canMoveAnything(seat) {
    return s.pawns[seat].some((p) => p >= 0 && p < FINISH);
  }

  function advanceTurn(extra) {
    s.roll = null;
    s.moves = [];
    s.phase = 'roll';
    if (extra && !isDone(s.current)) return;
    s.sixes = 0;
    s.tries = 0;
    do { s.current = (s.current + 1) % s.seats.length; } while (isDone(s.current));
  }

  function checkOver() {
    if (s.finished.length >= s.seats.length - 1) {
      for (let i = 0; i < s.seats.length; i++) if (!s.finished.includes(i)) s.finished.push(i);
      s.phase = 'over';
      return true;
    }
    return false;
  }

  const game = {
    get state() { return s; },
    rules: R,

    decision() {
      if (s.phase === 'over') return null;
      if (s.phase === 'roll') {
        const tries = R.threeTriesWhenStuck && !canMoveAnything(s.current) ? ` (try ${s.tries + 1}/3)` : '';
        return {
          seat: s.current, kind: 'roll',
          prompt: `${name(s.current)}: roll the die${tries}`,
          options: [{ label: 'Roll the die', alias: 'roll' }],
        };
      }
      return {
        seat: s.current, kind: 'choose',
        prompt: `${name(s.current)} rolled ${s.roll} — pick a pawn`,
        options: s.moves.map((m) => ({ label: label(m), data: m })),
      };
    },

    apply(index) {
      const seat = s.current;
      const events = [];
      const log = [];

      if (s.phase === 'roll') {
        const value = rng.int(1, 6);
        s.roll = value;
        s.sixes = value === 6 ? s.sixes + 1 : 0;
        events.push({ type: 'roll', seat, value });
        log.push(`${name(seat)} rolled a ${value}`);

        if (R.tripleSixForfeit && s.sixes === 3) {
          log.push('Three 6s in a row — turn over!');
          events.push({ type: 'pass', seat, reason: 'triple-six' });
          advanceTurn(false);
          return { events, log };
        }
        s.moves = legalMoves(seat, value);
        if (s.moves.length === 0) {
          const stuck = R.threeTriesWhenStuck && !canMoveAnything(seat);
          s.tries++;
          const retry = (stuck && s.tries < 3) || (value === 6 && R.sixExtraTurn);
          events.push({ type: 'pass', seat, reason: 'no-move' });
          if (!retry) log.push(`${name(seat)} can't move`);
          advanceTurn(retry);
          return { events, log };
        }
        s.phase = 'move';
        return { events, log };
      }

      // phase 'move'
      const m = s.moves[index];
      if (!m) throw new Error(`invalid move index ${index}`);
      const path = [];
      if (m.from === -1) path.push(0);
      else for (let p = m.from + 1; p <= m.to; p++) path.push(p);
      s.pawns[seat][m.pawn] = m.to;
      events.push({ type: 'move', seat, pawn: m.pawn, from: m.from, to: m.to, path });
      // Same-color pawns stacked on the same spot move as listed once; nothing else to do.
      for (const c of m.captures) {
        const from = s.pawns[c.seat][c.pawn];
        s.pawns[c.seat][c.pawn] = -1;
        events.push({ type: 'capture', seat: c.seat, pawn: c.pawn, from, by: seat });
        log.push(`${name(seat)} sends ${name(c.seat)} back home!`);
      }
      if (m.to === FINISH) log.push(`${name(seat)} brings a pawn home`);
      if (isDone(seat) && !s.finished.includes(seat)) {
        s.finished.push(seat);
        events.push({ type: 'finished', seat, place: s.finished.length });
        log.push(`${name(seat)} finished #${s.finished.length}!`);
      }
      if (checkOver()) {
        events.push({ type: 'gameOver', ranking: [...s.finished] });
        return { events, log };
      }
      const extra = (s.roll === 6 && R.sixExtraTurn) || (m.captures.length > 0 && R.captureBonus);
      advanceTurn(extra);
      return { events, log };
    },

    botChoice() {
      if (s.phase !== 'move') return 0;
      const seat = s.current;
      let best = 0;
      let bestScore = -Infinity;
      s.moves.forEach((m, i) => {
        let score = m.to * 0.3;
        if (m.captures.length) score += 100;
        if (m.to === FINISH) score += 80;
        if (m.from === -1) score += 60;
        if (m.from <= LAST_TRACK && m.to > LAST_TRACK) score += 40;
        if (m.to <= LAST_TRACK && SAFE_SQUARES.has(absSquare(color(seat), m.to))) score += 15;
        score -= danger(seat, m.to) * 18;
        if (m.from >= 0) score += danger(seat, m.from) * 12; // escaping a threat
        score += rng.next(); // tie-break
        if (score > bestScore) { bestScore = score; best = i; }
      });
      return best;
    },

    ranking() {
      if (s.phase === 'over') return [...s.finished];
      const progress = (seat) => s.pawns[seat].reduce((a, p) => a + Math.max(p, 0), 0);
      const rest = s.seats.map((_, i) => i).filter((i) => !s.finished.includes(i)).sort((a, b) => progress(b) - progress(a));
      return [...s.finished, ...rest];
    },
  };
  return game;
}
