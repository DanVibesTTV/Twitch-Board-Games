import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionBank, BUILTIN, CATEGORIES } from '../games/trivia/questions.js';

const enc = (s) => encodeURIComponent(s);
function fakeApi({ codes = [] } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes('api_token.php?command=request')) return { json: async () => ({ response_code: 0, token: 'TOKEN1' }) };
    if (url.includes('command=reset')) return { json: async () => ({ response_code: 0 }) };
    const forced = codes.shift();
    if (forced !== undefined && forced !== 0) return { json: async () => ({ response_code: forced, results: [] }) };
    const amount = Number(/amount=(\d+)/.exec(url)[1]);
    const results = Array.from({ length: amount }, () => {
      n++;
      return { type: 'multiple', difficulty: 'medium', question: enc(`Question ${n} &amp; "quotes"?`), correct_answer: enc(`Right ${n}`), incorrect_answers: [enc('W1'), enc('W2'), enc('W3')] };
    });
    return { json: async () => ({ response_code: 0, results }) };
  };
  return { fetch, calls };
}
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('preload fills all six slots through a rate-limited queue with a session token', async () => {
  const api = fakeApi();
  const c = clock();
  const bank = new QuestionBank({ fetch: api.fetch, storage: memory(), ...c });
  const start = c.now();
  await bank.preload();
  assert.ok(bank.ready());
  for (let i = 0; i < 6; i++) assert.ok(bank.count(i) >= 4);
  const qCalls = api.calls.filter((u) => u.includes('api.php'));
  assert.equal(qCalls.length, 6);
  assert.ok(qCalls.every((u) => u.includes('token=TOKEN1') && u.includes('encode=url3986')));
  assert.ok(c.now() - start >= 6 * 5000, 'requests were spaced ≥5 s apart');
  // Entertainment slot asks one of its four sub-categories
  const ent = qCalls.find((u) => /category=(11|12|14|15)\b/.test(u));
  assert.ok(ent);
});

test('take() decodes, shuffles, and falls back to built-in questions when empty', async () => {
  const api = fakeApi();
  const bank = new QuestionBank({ fetch: api.fetch, storage: memory(), ...clock() });
  const offline = bank.take(5); // nothing loaded yet → built-in Comics question
  assert.equal(offline.source, 'builtin');
  assert.ok(BUILTIN.comics.some((x) => x.text === offline.text));
  assert.equal(offline.answers[offline.correctIndex], BUILTIN.comics.find((x) => x.text === offline.text).correct);
  await bank.preload();
  const q = bank.take(0);
  assert.equal(q.source, 'opentdb');
  assert.match(q.text, /^Question \d+ &amp; "quotes"\?$/);
  assert.equal(q.answers.length, 4);
  assert.match(q.answers[q.correctIndex], /^Right \d+$/);
});

test('handles token reset, rate limit and too-few-questions codes', async () => {
  const api = fakeApi({ codes: [4, 5, 1] }); // empty token → reset, rate limited → retry, not enough → fewer
  const bank = new QuestionBank({ fetch: api.fetch, storage: memory(), ...clock() });
  await bank.fill(0);
  assert.ok(api.calls.some((u) => u.includes('command=reset&token=TOKEN1')));
  assert.ok(bank.count(0) > 0);
  assert.ok(api.calls.some((u) => u.includes('amount=5')), 'asked for fewer after code 1');
});

test('network failure: no crash, built-in questions, back-off', async () => {
  const c = clock();
  const bank = new QuestionBank({ fetch: async () => { throw new Error('offline'); }, storage: memory(), ...c });
  await bank.preload();
  assert.equal(bank.ready(), false);
  assert.equal(bank.take(2).source, 'builtin');
  assert.equal(await bank.waitReady(5000), false);
});

test('cache survives a restart; slots can be changed and persist', async () => {
  const storage = memory();
  const bank = new QuestionBank({ fetch: fakeApi().fetch, storage, ...clock() });
  await bank.preload();
  const again = new QuestionBank({ fetch: async () => { throw new Error('no network needed'); }, storage, ...clock() });
  assert.ok(again.ready(), 'questions came from the cache');
  assert.equal(again.setSlot(5, 'sports'), true);
  assert.equal(again.setSlot(5, 'nonsense'), false);
  assert.equal(new QuestionBank({ storage, fetch: null }).slots[5].name, CATEGORIES.sports.name);
  again.resetSlots();
  assert.equal(new QuestionBank({ storage, fetch: null }).slots[5].key, 'comics');
});
