// Trivia Champ rules (Trivial Pursuit style). Implements the Game API (docs/GAME_API.md).
//
// Turn: roll → pick a destination (exact roll, no backtracking) → answer a question in the
// space's category. Correct = roll again; on an HQ you also earn that category's wedge.
// Wrong (or time out) = next player. Roll-again spaces skip the question. At the hub you pick
// the category yourself. With all wedges, reach the hub and answer a final question in a
// category chosen by the next player. Everyone starts on the hub.

import { HUB, nodeInfo, destinations, isHQ } from './wheel.js';
import { fallbackQuestion, DEFAULT_SLOTS, CATEGORIES, SLOT_COLORS } from './questions.js';

export const DEFAULT_RULES = {
  wedgesToWin: 6,
  finalQuestion: true,       // need to answer a final question at the hub after collecting the wedges
  answerSeconds: 30,
  botSkill: { easy: 0.8, medium: 0.6, hard: 0.42 },
};

// Used when no question bank was prepared (e.g. tests): built-in questions only.
function offlineBank() {
  return {
    slots: DEFAULT_SLOTS.map((key, i) => ({ key, name: CATEGORIES[key].name, color: SLOT_COLORS[i] })),
    take(slot, rng) {
      const key = DEFAULT_SLOTS[slot];
      const q = fallbackQuestion(key, rng);
      const answers = [q.correct, ...q.incorrect];
      for (let i = answers.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [answers[i], answers[j]] = [answers[j], answers[i]];
      }
      return { text: q.text, answers, correctIndex: answers.indexOf(q.correct), difficulty: 'easy', category: CATEGORIES[key].name, slot, source: 'builtin' };
    },
  };
}

export function createGame({ seats, rng, rules = {}, ctx = null }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const bank = ctx?.bank ?? offlineBank();
  const slots = ctx?.slots ?? bank.slots;
  const s = {
    seats: [...seats],
    slots,
    pos: seats.map(() => HUB),
    wedges: seats.map(() => new Array(6).fill(false)),
    current: 0,
    phase: 'roll',
    roll: null,
    dests: [],
    question: null,   // { ...question, seat, hq, final }
    picker: null,     // who picks the final category
    winner: null,
    turns: 0,
  };
  const name = (seat) => s.seats[seat][0].toUpperCase() + s.seats[seat].slice(1);
  const count = (seat) => s.wedges[seat].filter(Boolean).length;
  const complete = (seat) => count(seat) >= R.wedgesToWin;
  const nextSeat = (seat) => (seat + 1) % s.seats.length;

  function describe(node, seat) {
    const info = nodeInfo(node);
    if (info.kind === 'hub') return complete(seat) && R.finalQuestion ? 'Hub: FINAL QUESTION' : 'Hub: pick any category';
    if (info.kind === 'again') return 'Roll again';
    const cat = slots[info.slot].name;
    if (info.kind === 'hq') return s.wedges[seat][info.slot] ? `${cat} HQ` : `${cat} HQ: wedge!`;
    return cat;
  }

  // Order destinations so the most interesting come first (numbers match the board markers).
  function priority(node, seat) {
    const info = nodeInfo(node);
    if (info.kind === 'hub' && complete(seat) && R.finalQuestion) return 0;
    if (info.kind === 'hq' && !s.wedges[seat][info.slot]) return 1;
    if (info.kind === 'again') return 2;
    if (info.kind === 'hub') return 3;
    return 4;
  }

  function ask(seat, slot, flags = {}) {
    s.question = { ...bank.take(slot, rng), seat, hq: !!flags.hq, final: !!flags.final };
    s.phase = 'question';
    return { type: 'question', seat, slot, final: !!flags.final };
  }

  function land(seat, node, events, log) {
    const info = nodeInfo(node);
    if (info.kind === 'again') {
      events.push({ type: 'rollAgain', seat, node });
      log.push(`${name(seat)} lands on Roll again`);
      s.phase = 'roll';
      return;
    }
    if (info.kind === 'hub') {
      if (complete(seat) && R.finalQuestion) {
        s.picker = nextSeat(seat);
        s.phase = 'finalPick';
        log.push(`${name(seat)} reaches the hub with all wedges: final question!`);
      } else {
        s.phase = 'pickCategory';
      }
      return;
    }
    events.push(ask(seat, info.slot, { hq: isHQ(node) }));
  }

  const game = {
    get state() { return s; },
    rules: R,

    decision() {
      const seat = s.current;
      switch (s.phase) {
        case 'roll':
          return {
            seat, kind: 'roll',
            prompt: `${name(seat)} (${count(seat)}/${R.wedgesToWin} wedges): roll the die`,
            options: [{ label: 'Roll the die', alias: 'roll' }],
          };
        case 'move':
          return {
            seat, kind: 'choose',
            prompt: `${name(seat)} rolled ${s.roll}: where to?`,
            options: s.dests.map((d) => ({ label: describe(d.node, seat), data: d })),
          };
        case 'pickCategory':
          return {
            seat, kind: 'choose',
            prompt: `${name(seat)} is on the hub: pick a category`,
            options: slots.map((c) => ({ label: c.name, color: c.color })),
          };
        case 'finalPick':
          return {
            seat: s.picker, kind: 'choose',
            prompt: `${name(s.picker)}: pick the FINAL category for ${name(seat)}`,
            options: slots.map((c) => ({ label: c.name, color: c.color })),
          };
        case 'question': {
          const q = s.question;
          return {
            seat, kind: 'question',
            prompt: `${q.final ? 'FINAL QUESTION · ' : ''}${q.category}`,
            seconds: R.answerSeconds,
            question: {
              text: q.text, category: q.category, color: slots[q.slot].color, difficulty: q.difficulty,
              final: q.final, hq: q.hq, source: q.source,
            },
            options: q.answers.map((a) => ({ label: a })),
          };
        }
        default:
          return null;
      }
    },

    apply(index) {
      const seat = s.current;
      const events = [];
      const log = [];
      switch (s.phase) {
        case 'roll': {
          const value = rng.int(1, 6);
          s.roll = value;
          s.turns++;
          s.dests = destinations(s.pos[seat], value).sort((a, b) => priority(a.node, seat) - priority(b.node, seat) || a.node - b.node);
          s.phase = 'move';
          events.push({ type: 'roll', seat, value });
          log.push(`${name(seat)} rolled a ${value}`);
          break;
        }
        case 'move': {
          const d = s.dests[index];
          if (!d) throw new Error(`invalid destination ${index}`);
          events.push({ type: 'move', seat, from: s.pos[seat], to: d.node, path: d.path });
          s.pos[seat] = d.node;
          s.dests = [];
          land(seat, d.node, events, log);
          break;
        }
        case 'pickCategory':
        case 'finalPick': {
          if (!slots[index]) throw new Error(`invalid category ${index}`);
          const final = s.phase === 'finalPick';
          if (final) log.push(`${name(s.picker)} picks ${slots[index].name} for the final question`);
          s.picker = null;
          events.push(ask(seat, index, { final }));
          break;
        }
        case 'question': {
          const q = s.question;
          const timeout = index === 'timeout';
          const correct = !timeout && index === q.correctIndex;
          events.push({ type: 'answer', seat, chosen: timeout ? null : index, correctIndex: q.correctIndex, correct, timeout, final: q.final });
          if (correct) {
            log.push(`✅ ${name(seat)} got it right!`);
            if (q.final) {
              s.winner = seat;
            } else if (q.hq && !s.wedges[seat][q.slot]) {
              s.wedges[seat][q.slot] = true;
              events.push({ type: 'wedge', seat, slot: q.slot, total: count(seat) });
              log.push(`🧀 ${name(seat)} earns the ${slots[q.slot].name} wedge (${count(seat)}/${R.wedgesToWin})`);
              if (complete(seat) && !R.finalQuestion) s.winner = seat;
            }
          } else {
            log.push(`${timeout ? '⏰ Time is up' : `❌ ${name(seat)} missed it`}. Answer: ${q.answers[q.correctIndex]}`);
          }
          s.question = null;
          if (s.winner !== null) {
            s.phase = 'over';
            events.push({ type: 'win', seat });
          } else {
            if (!correct) s.current = nextSeat(seat);
            s.phase = 'roll';
          }
          break;
        }
        default:
          throw new Error('game is over');
      }
      return { events, log };
    },

    // Time ran out on a question: it counts as a wrong answer (never answered by the bot).
    timeoutChoice() {
      return s.phase === 'question' ? 'timeout' : undefined;
    },

    botChoice() {
      const seat = s.phase === 'finalPick' ? s.picker : s.current;
      switch (s.phase) {
        case 'move': {
          // prefer: final hub > missing wedge > roll again > hub > anything (random among equals)
          let best = 0;
          let bestScore = Infinity;
          s.dests.forEach((d, i) => {
            const score = priority(d.node, s.current) + rng.next() * 0.5;
            if (score < bestScore) { bestScore = score; best = i; }
          });
          return best;
        }
        case 'pickCategory':
        case 'finalPick':
          return rng.int(0, slots.length - 1);
        case 'question': {
          const q = s.question;
          const p = R.botSkill[q.difficulty] ?? 0.6;
          if (rng.next() < p) return q.correctIndex;
          const wrong = q.answers.map((_, i) => i).filter((i) => i !== q.correctIndex);
          return wrong[Math.floor(rng.next() * wrong.length)];
        }
        default:
          return 0;
      }
    },

    ranking() {
      const order = s.seats.map((_, i) => i).sort((a, b) => count(b) - count(a) || a - b);
      if (s.winner === null) return order;
      return [s.winner, ...order.filter((i) => i !== s.winner)];
    },
  };
  return game;
}
