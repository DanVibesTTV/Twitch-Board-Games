// A live-like trivia bank for tests: random built-in questions (Math.random, like the real
// shuffled pools), so only recording + replaying keeps two phones in step.
import { CATEGORIES, DEFAULT_SLOTS, SLOT_COLORS, fallbackQuestion } from '../../games/trivia/questions.js';

export function offlineQuestionBankForTests() {
  return {
    slots: DEFAULT_SLOTS.map((key, i) => ({ key, name: CATEGORIES[key].name, color: SLOT_COLORS[i] })),
    take(slot) {
      const key = DEFAULT_SLOTS[slot];
      const q = fallbackQuestion(key);
      const answers = [q.correct, ...q.incorrect].sort(() => Math.random() - 0.5);
      return { text: q.text, answers, correctIndex: answers.indexOf(q.correct), difficulty: 'easy', category: CATEGORIES[key].name, slot, source: 'builtin' };
    },
  };
}
