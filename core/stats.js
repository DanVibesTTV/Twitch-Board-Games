// Viewer stats: wins per game, wins over all games, winning streaks.
// Saved through core/storage.js: the browser's localStorage, or a file on the PC when the
// overlay runs from the companion app.
//
// What counts:
//   - only human players (bots and chat-vote seats are never credited)
//   - every human seated when the game started "played" it, including players who
//     left or went AFK and got replaced by a bot (so leaving can't protect a streak)
//   - a win adds 1 to the streak; a loss resets it; a draw leaves it unchanged
//   - games stopped with !bg stop are not recorded

import { storage as defaultStorage } from './storage.js';

const KEY = 'boardgames.stats.v1';

const emptyData = () => ({ version: 1, players: {}, games: {} });

export class StatsStore {
  // storage: anything with getItem/setItem (localStorage, or a fake in tests)
  constructor(storage = defaultStorage) {
    this.storage = storage;
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = this.storage?.getItem(KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data?.version === 1 && data.players && data.games) return data;
    } catch (err) {
      console.warn('[stats] could not read saved stats, starting fresh', err);
    }
    return emptyData();
  }

  #save() {
    try { this.storage?.setItem(KEY, JSON.stringify(this.data)); } catch (err) { console.warn('[stats] could not save', err); }
  }

  // players: [{ id, name }] — every human who was seated at the start.
  // winnerId: id of the winning human, or null (bot/chat won, or draw).
  record({ gameId, players, winnerId = null, draw = false, at = Date.now() }) {
    if (!players?.length) return;
    const game = (this.data.games[gameId] ??= { players: {} });
    for (const p of players) {
      const all = (this.data.players[p.id] ??= { name: p.name, wins: 0, played: 0, streak: 0, bestStreak: 0 });
      const per = (game.players[p.id] ??= { wins: 0, played: 0 });
      all.name = p.name; // keep the latest display name
      all.played++;
      per.played++;
      all.lastPlayed = at;
      if (p.id === winnerId) {
        all.wins++;
        per.wins++;
        all.streak++;
        all.bestStreak = Math.max(all.bestStreak, all.streak);
      } else if (!draw) {
        all.streak = 0;
      }
    }
    this.#save();
  }

  // Leaderboard pages for the game select screen.
  // manifests: installed games (for names and order). Per-game pages only appear once a game has results.
  pages(manifests = [], limit = 10) {
    const P = this.data.players;
    const name = (id) => P[id]?.name ?? id;
    const rate = (w, n) => (n ? Math.round((w / n) * 100) : 0);
    const sortRows = (rows) => rows.sort((a, b) => b.value - a.value || a.played - b.played || a.name.localeCompare(b.name)).slice(0, limit);

    const pages = [];
    pages.push({
      id: 'overall',
      title: 'Most wins: all games',
      unit: 'wins',
      rows: sortRows(Object.entries(P).filter(([, s]) => s.wins > 0).map(([id, s]) => ({
        id, name: s.name, value: s.wins, played: s.played, detail: `${s.played} played · ${rate(s.wins, s.played)}%`,
      }))),
    });
    pages.push({
      id: 'streak',
      title: 'Longest winning streak',
      unit: 'in a row',
      rows: sortRows(Object.entries(P).filter(([, s]) => s.bestStreak > 0).map(([id, s]) => ({
        id, name: s.name, value: s.bestStreak, played: s.played, detail: s.streak > 0 ? `🔥 ${s.streak} right now` : `${s.wins} wins total`,
      }))),
    });
    for (const m of manifests) {
      const g = this.data.games[m.id];
      if (!g) continue;
      const rows = Object.entries(g.players).filter(([, s]) => s.wins > 0).map(([id, s]) => ({
        id, name: name(id), value: s.wins, played: s.played, detail: `${s.played} played · ${rate(s.wins, s.played)}%`,
      }));
      if (rows.length) pages.push({ id: m.id, title: `Most wins: ${m.name}`, unit: 'wins', rows: sortRows(rows) });
    }
    return pages;
  }

  // One-line summary for "!bgstats me".
  summary(userId, manifests = []) {
    const s = this.data.players[userId];
    if (!s) return null;
    const best = manifests
      .map((m) => ({ m, w: this.data.games[m.id]?.players[userId]?.wins ?? 0 }))
      .filter((x) => x.w > 0)
      .sort((a, b) => b.w - a.w)[0];
    const parts = [`${s.wins} win${s.wins === 1 ? '' : 's'} in ${s.played} game${s.played === 1 ? '' : 's'}`];
    parts.push(`best streak ${s.bestStreak}`);
    if (s.streak > 1) parts.push(`🔥 on a ${s.streak}-win streak`);
    if (best) parts.push(`best at ${best.m.name} (${best.w})`);
    return `${s.name}: ${parts.join(' · ')}`;
  }

  // Wipe everything, or one game's per-game board (overall wins and streaks stay).
  reset(gameId = null) {
    if (gameId) delete this.data.games[gameId];
    else this.data = emptyData();
    this.#save();
  }
}
