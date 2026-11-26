// Four in a Row — drop discs into a 7×6 grid, first to line up four wins.
// Implements the Game API (docs/GAME_API.md).
//
// Every decision lists all 7 columns so "!3" always means column 3;
// full columns are marked `disabled` (the core rejects them).

export const COLS = 7;
export const ROWS = 6;

export const DEFAULT_RULES = {
  botDepth: 5,      // look-ahead in moves; 5 is strong but beatable
  botMistakes: 0.1, // chance per move that the bot plays a weaker (but safe) move
};

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// board[c][r]: r = 0 is the bottom row. Values: -1 empty, else seat index.
export function emptyBoard() {
  return Array.from({ length: COLS }, () => new Array(ROWS).fill(-1));
}

export function dropRow(board, col) {
  return board[col].indexOf(-1); // -1 = full
}

// Returns the four winning cells through (c, r), or null.
export function winningLine(board, c, r) {
  const who = board[c][r];
  if (who < 0) return null;
  for (const [dc, dr] of DIRS) {
    const cells = [[c, r]];
    for (const sign of [1, -1]) {
      let x = c + dc * sign;
      let y = r + dr * sign;
      while (x >= 0 && x < COLS && y >= 0 && y < ROWS && board[x][y] === who) {
        cells.push([x, y]);
        x += dc * sign;
        y += dr * sign;
      }
    }
    if (cells.length >= 4) return cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 4);
  }
  return null;
}

export function createGame({ seats, rng, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const s = {
    seats: [...seats],
    board: emptyBoard(),
    current: 0,
    moves: 0,
    winner: null,
    line: null,
    over: false,
  };
  const name = (seat) => s.seats[seat][0].toUpperCase() + s.seats[seat].slice(1);

  return {
    get state() { return s; },
    rules: R,

    decision() {
      if (s.over) return null;
      return {
        seat: s.current,
        kind: 'choose',
        prompt: `${name(s.current)}: drop a disc — pick a column 1–7`,
        options: Array.from({ length: COLS }, (_, c) => ({
          label: `Column ${c + 1}`,
          disabled: dropRow(s.board, c) === -1,
          data: { col: c },
        })),
      };
    },

    apply(index) {
      const seat = s.current;
      const col = index;
      const row = dropRow(s.board, col);
      if (row === -1) throw new Error(`column ${col + 1} is full`);
      s.board[col][row] = seat;
      s.moves++;
      const events = [{ type: 'drop', seat, col, row }];
      const log = [`${name(seat)} drops into column ${col + 1}`];
      const line = winningLine(s.board, col, row);
      if (line) {
        s.over = true;
        s.winner = seat;
        s.line = line;
        events.push({ type: 'win', seat, line });
        log.push(`${name(seat)} connects four!`);
      } else if (s.moves === COLS * ROWS) {
        s.over = true;
        events.push({ type: 'draw' });
        log.push('The board is full — draw!');
      } else {
        s.current = 1 - seat;
      }
      return { events, log };
    },

    botChoice() {
      return chooseMove(s.board, s.current, R, rng);
    },

    isDraw: () => s.over && s.winner === null,

    ranking() {
      if (s.winner === null) return [s.current, 1 - s.current];
      return [s.winner, 1 - s.winner];
    },
  };
}

// ───────────────────────────── bot ─────────────────────────────
// Negamax with alpha-beta pruning, center-first move order and a window heuristic.

const ORDER = [3, 2, 4, 1, 5, 0, 6];
const WIN = 1_000_000;

export function chooseMove(board, me, R = DEFAULT_RULES, rng = { next: Math.random }) {
  const b = board.map((col) => col.slice());
  const legal = ORDER.filter((c) => dropRow(b, c) !== -1);
  const scored = legal.map((c) => {
    const r = dropRow(b, c);
    b[c][r] = me;
    const score = winningLine(b, c, r) ? WIN : -negamax(b, 1 - me, R.botDepth - 1, -Infinity, Infinity);
    b[c][r] = -1;
    return { c, score };
  });
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  // Occasionally play the second-best move, but never miss a win or allow an immediate loss.
  if (scored.length > 1 && rng.next() < R.botMistakes && best.score < WIN / 2) {
    const alt = scored[1];
    if (alt.score > -WIN / 2) return alt.c;
  }
  return best.c;
}

function negamax(b, who, depth, alpha, beta) {
  let any = false;
  if (depth <= 0) return evaluate(b, who);
  let best = -Infinity;
  for (const c of ORDER) {
    const r = dropRow(b, c);
    if (r === -1) continue;
    any = true;
    b[c][r] = who;
    // prefer faster wins / slower losses via depth bonus
    const score = winningLine(b, c, r) ? WIN + depth : -negamax(b, 1 - who, depth - 1, -beta, -alpha);
    b[c][r] = -1;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return any ? best : 0; // full board = draw
}

// Scores every 4-cell window: more own discs with empty rest = good, same for opponent = bad.
function evaluate(b, who) {
  let score = 0;
  for (let r = 0; r < ROWS; r++) if (b[3][r] === who) score += 3; else if (b[3][r] === 1 - who) score -= 3;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      for (const [dc, dr] of DIRS) {
        const ec = c + dc * 3;
        const er = r + dr * 3;
        if (ec < 0 || ec >= COLS || er < 0 || er >= ROWS) continue;
        let mine = 0;
        let theirs = 0;
        for (let k = 0; k < 4; k++) {
          const v = b[c + dc * k][r + dr * k];
          if (v === who) mine++;
          else if (v === 1 - who) theirs++;
        }
        if (theirs === 0) score += mine === 3 ? 50 : mine === 2 ? 8 : mine;
        else if (mine === 0) score -= theirs === 3 ? 60 : theirs === 2 ? 8 : theirs;
      }
    }
  }
  return score;
}
