// Tubes & Teleporters: Snakes and Ladders rules on a 10×10 board.
// Tubes suck you down (snakes), teleporters beam you up (ladders).
// Implements the Game API (docs/GAME_API.md).
//
// Position per player: 0 = launch bay (off the board), 1..100 = squares.

export const GOAL = 100;

// start → end. Teleporters go up, tubes go down. No square is both a start and an end.
export const TELEPORTERS = { 4: 25, 13: 46, 33: 49, 42: 63, 50: 69, 62: 81, 74: 92 };
export const TUBES = { 27: 5, 40: 3, 43: 18, 54: 31, 66: 45, 76: 58, 89: 53, 99: 41 };

export const DEFAULT_RULES = {
  exactFinish: true,   // overshooting 100 bounces back by the extra pips
  sixExtraTurn: false, // classic rules: no extra roll on a 6
  playToEnd: false,    // false = game ends when the first player reaches 100
};

export function createGame({ seats, rng, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const s = {
    seats: [...seats],
    pos: seats.map(() => 0),
    current: 0,
    finished: [],
    over: false,
    lastRoll: null,
  };
  const name = (seat) => s.seats[seat][0].toUpperCase() + s.seats[seat].slice(1);
  const nextSeat = () => {
    do { s.current = (s.current + 1) % s.seats.length; } while (s.finished.includes(s.current));
  };

  return {
    get state() { return s; },
    rules: R,

    decision() {
      if (s.over) return null;
      const p = s.pos[s.current];
      return {
        seat: s.current,
        kind: 'roll',
        prompt: `${name(s.current)} is on ${p === 0 ? 'the launch bay' : `square ${p}`}: roll!`,
        options: [{ label: 'Roll the die', alias: 'roll' }],
      };
    },

    apply() {
      const seat = s.current;
      const roll = rng.int(1, 6);
      s.lastRoll = roll;
      const events = [{ type: 'roll', seat, value: roll }];
      const log = [`${name(seat)} rolled a ${roll}`];

      // walk square by square, bouncing back off 100 if needed
      const from = s.pos[seat];
      const path = [];
      let p = from;
      let dir = 1;
      for (let i = 0; i < roll; i++) {
        if (p === GOAL) {
          if (!R.exactFinish) break; // reaching 100 is enough
          dir = -1;
        }
        p += dir;
        path.push(p);
      }
      s.pos[seat] = p;
      events.push({ type: 'move', seat, from, to: p, path, bounced: dir === -1 });
      if (dir === -1) log.push(`${name(seat)} overshoots and bounces back to ${p}`);

      if (TELEPORTERS[p]) {
        const to = TELEPORTERS[p];
        events.push({ type: 'teleport', seat, from: p, to });
        log.push(`⚡ ${name(seat)} teleports from ${p} to ${to}!`);
        s.pos[seat] = to;
      } else if (TUBES[p]) {
        const to = TUBES[p];
        events.push({ type: 'tube', seat, from: p, to });
        log.push(`🌀 ${name(seat)} gets sucked down a tube to ${to}!`);
        s.pos[seat] = to;
      }

      if (s.pos[seat] === GOAL) {
        s.finished.push(seat);
        events.push({ type: 'finished', seat, place: s.finished.length });
        log.push(`🏁 ${name(seat)} reaches 100!`);
        if (!R.playToEnd || s.finished.length >= s.seats.length - 1) {
          s.over = true;
          events.push({ type: 'gameOver', ranking: this.ranking() });
          return { events, log };
        }
      }
      if (!(roll === 6 && R.sixExtraTurn) || s.finished.includes(seat)) nextSeat();
      return { events, log };
    },

    botChoice: () => 0,

    ranking() {
      const rest = s.seats.map((_, i) => i).filter((i) => !s.finished.includes(i)).sort((a, b) => s.pos[b] - s.pos[a]);
      return [...s.finished, ...rest];
    },
  };
}
