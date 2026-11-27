// Trivia Champ add-on entry.
// Besides the usual createGame/createRenderer it uses the optional core hooks:
//   preload()      → start fetching questions as soon as the lobby opens
//   prepare()      → wait (briefly) until every category has a question, then hand the bank to the game
//   adminCommand() → "!bg cat …" to change the six categories in the lobby
//   lobbyInfo()    → category chips + credit line for the lobby panel

import { QuestionBank, CATEGORIES } from './questions.js';

export { createGame } from './logic.js';
export { createRenderer } from './renderer.js';
export { lan } from './lan.js'; // same-WiFi play: questions recorded on the host, replayed elsewhere

let bank = null;
const getBank = () => (bank ??= new QuestionBank());

export function preload() {
  getBank().preload().catch((err) => console.warn('[trivia] preload failed', err));
}

export async function prepare() {
  const b = getBank();
  await b.waitReady(8000); // the lobby usually had time to fill everything; never wait forever
  return { bank: b, slots: b.slots };
}

export function lobbyInfo() {
  const b = getBank();
  return {
    chips: b.slots.map((s, i) => ({ color: s.color, label: `${i + 1} ${s.name}`, ready: b.count(i) > 0 })),
    note: 'Questions: Open Trivia Database (opentdb.com), CC BY-SA 4.0',
  };
}

// !bg cat                 → list the six categories and what can be chosen
// !bg cat <1-6> <name>    → change one, e.g. "!bg cat 6 sports"
// !bg cat reset           → back to the defaults
export function adminCommand(sub, arg, api) {
  if (sub !== 'cat' && sub !== 'category') return false;
  const b = getBank();
  const p = api.prefix;
  const words = (arg ?? '').split(/\s+/).filter(Boolean);
  if (words[0] === 'reset') {
    b.resetSlots();
    api.say(`Trivia categories reset: ${b.slots.map((s) => s.name).join(', ')}.`);
  } else if (words.length >= 2) {
    const slot = Number(words[0]) - 1;
    const key = words[1];
    if (!b.setSlot(slot, key)) {
      api.say(`Usage: ${p}bg cat <1-6> <${Object.keys(CATEGORIES).join('|')}>`);
      return true;
    }
    api.say(`Category ${slot + 1} is now ${CATEGORIES[key].name}.`);
    b.fill(slot);
  } else {
    api.say(`Trivia categories: ${b.slots.map((s, i) => `${i + 1} ${s.name}`).join(' · ')}. Change with ${p}bg cat <1-6> <${Object.keys(CATEGORIES).join('|')}> or ${p}bg cat reset.`);
  }
  api.refresh();
  return true;
}
