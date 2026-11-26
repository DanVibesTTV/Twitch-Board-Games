import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatsStore } from '../core/stats.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };
const A = { id: '1', name: 'alice' };
const B = { id: '2', name: 'bob' };
const C = { id: '3', name: 'carl' };
const games = [{ id: 'ludo', name: 'Ludo' }, { id: 'four', name: 'Four in a Row' }, { id: 'tubes', name: 'Tubes & Teleporters' }];

test('wins per game, overall, streaks; draws keep streaks, losses reset them', () => {
  const s = new StatsStore(memory());
  s.record({ gameId: 'four', players: [A, B], winnerId: '1' });
  s.record({ gameId: 'four', players: [A, B], winnerId: '1' });
  s.record({ gameId: 'ludo', players: [A, B, C], winnerId: '1' });
  assert.equal(s.data.players['1'].streak, 3);
  s.record({ gameId: 'four', players: [A, B], draw: true });
  assert.equal(s.data.players['1'].streak, 3, 'draw keeps the streak');
  s.record({ gameId: 'ludo', players: [A, C], winnerId: '3' });
  assert.equal(s.data.players['1'].streak, 0, 'loss resets');
  assert.equal(s.data.players['1'].bestStreak, 3);
  s.record({ gameId: 'ludo', players: [A, B], winnerId: null }); // a bot won
  assert.equal(s.data.players['2'].played, 5);

  const pages = s.pages(games);
  assert.deepEqual(pages.map((p) => p.id), ['overall', 'streak', 'ludo', 'four'], 'tubes has no results → no page');
  assert.deepEqual(pages[0].rows.map((r) => [r.name, r.value]), [['alice', 3], ['carl', 1]]);
  assert.equal(pages[1].rows[0].value, 3);
  assert.deepEqual(pages[3].rows.map((r) => [r.name, r.value]), [['alice', 2]]);
});

test('persists and reloads; survives corrupt storage', () => {
  const store = memory();
  new StatsStore(store).record({ gameId: 'four', players: [A, B], winnerId: '2' });
  assert.equal(new StatsStore(store).data.players['2'].wins, 1);
  store.setItem('boardgames.stats.v1', '{not json');
  assert.deepEqual(new StatsStore(store).data.players, {});
});

test('summary, name updates, reset', () => {
  const s = new StatsStore(memory());
  s.record({ gameId: 'four', players: [A, B], winnerId: '1' });
  s.record({ gameId: 'four', players: [{ id: '1', name: 'Alice_TTV' }, B], winnerId: '1' });
  assert.match(s.summary('1', games), /^Alice_TTV: 2 wins in 2 games · best streak 2 · 🔥 on a 2-win streak · best at Four in a Row \(2\)$/);
  assert.equal(s.summary('nobody', games), null);
  s.reset('four');
  assert.equal(s.data.games.four, undefined);
  assert.equal(s.data.players['1'].wins, 2, 'per-game reset keeps overall');
  s.reset();
  assert.deepEqual(s.data.players, {});
});
