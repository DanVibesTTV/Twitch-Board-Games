// The Session runs everything game-independent: menu/game vote, lobby & seats,
// turn timers, crowd votes, bots taking over for AFK players, predictions,
// and talking to chat. Games only provide rules (see docs/GAME_API.md).
//
// Phases: 'menu' → 'lobby' → 'playing' → 'over' → back to 'lobby' (rematch) or 'menu'.
//
// Same-WiFi play (net/lan.js): the host's Session runs as usual and also emits 'lanStart'
// (seed, seats, rules) and 'lanApply' (option index + RNG state) so the other phones can run an
// identical copy of the game. Their Sessions are followers: no chat, no timers, no bots — they
// only replay what the host sends (followMenu / followLobby / followStart / followApply /
// followDecision).

import { Emitter } from './emitter.js';
import { parseCommand } from './commands.js';
import { createRng } from './rng.js';

export const CORE_VERSION = '1.0.0';

// Resolves when `promise` does, or after `ms` — the game keeps going even if an animation hangs.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => { console.warn(`[session] ${what} took over ${ms / 1000}s, continuing`); resolve(); }, ms);
    }),
  ]);
}

export const DEFAULT_CONFIG = {
  prefix: '!',
  lobbySeconds: 45,        // countdown after the first player joins
  fullStartSeconds: 4,     // short countdown once every seat is taken
  turnSeconds: 30,         // per human decision
  voteSeconds: 15,         // crowd-seat decisions and game votes
  botDelayMs: 900,         // bots "think" briefly so moves are watchable
  autoSingleMoveMs: 1200,  // a human with exactly one legal move gets it played for them
  autoRoll: false,         // true = humans don't need to type !roll
  afkLimit: 3,             // consecutive timeouts before a bot takes the seat
  fillBots: true,          // fill empty seats with bots when the lobby closes
  minHumans: 1,
  predictions: true,
  predictionSeconds: 60,
  overSeconds: 15,         // how long the winner screen shows before moving on
  afterGame: 'menu',
  statsCooldownMs: 2500,   // !bgstats turns the page at most this often
  lobbyReminders: [30, 10], // chat reminders this many seconds before the lobby closes       // 'menu' (back to game select) or 'lobby' (rematch of the same game)
};

export class Session extends Emitter {
  constructor({ bridge, registry, view = null, config = {}, scheduler = globalThis, stats = null, follower = false }) {
    super();
    this.follower = follower; // true on a phone that joined someone else's game
    this.lanHost = false;     // true while this phone hosts a same-WiFi game (set by net/lan.js)
    this.bridge = bridge;
    this.registry = registry;
    this.view = view;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sched = scheduler;
    this.stats = stats;       // StatsStore or null
    this.statsIndex = 0;      // which leaderboard page the game select screen shows
    this.statsTurnedAt = 0;

    this.phase = 'menu';
    this.manifest = null;
    this.module = null;
    this.game = null;
    this.seats = [];
    this.decision = null;
    this.votes = new Map();   // userId → option index (crowd seat or game vote)
    this.gameVote = null;     // { options: manifest[] } while a game vote runs
    this.prediction = null;   // set while a prediction is open
    this.mode = null;         // current game mode (manifest.modes entry) or null
    this.entrants = new Map(); // userId → user, for modes that draw players at random
    this.#busy = false;

    bridge.on('chat', (msg) => this.handleChat(msg));
  }

  #busy;
  #lanRecords = []; // game data the host recorded during a move (e.g. trivia questions), see game module `lan`
  #starting = false;
  #timer = null;
  #reminders = [];
  #token = 0; // invalidates stale timers/votes whenever the decision changes

  // ───────────────────────────── chat ─────────────────────────────

  handleChat(msg) {
    if (this.follower) return; // a joined phone sends its commands to the host instead
    const cmd = parseCommand(msg, this.config.prefix);
    if (!cmd) return;
    if (cmd.kind === 'admin') return this.#admin(cmd, msg);
    if (cmd.kind === 'stats') return this.#statsCommand(msg.user, cmd.arg);

    switch (this.phase) {
      case 'menu':
        if (this.gameVote && cmd.kind === 'choose') this.#castVote(msg.user, cmd.index - 1, this.gameVote.options.length);
        break;
      case 'lobby':
        if (cmd.kind === 'join') this.join(msg.user, cmd.arg);
        else if (cmd.kind === 'leave') this.leave(msg.user);
        break;
      case 'playing':
        if (cmd.kind === 'leave') this.leave(msg.user);
        else if (cmd.kind === 'choose' || cmd.kind === 'alias') this.#playerInput(msg.user, cmd);
        break;
    }
  }

  #admin(cmd, msg) {
    const { sub, arg } = cmd;
    if (sub === 'menu') return this.toMenu();
    if (sub === 'play' && arg) {
      const [gameId, modeId] = arg.split(/\s+/);
      return this.openLobby(gameId, modeId, msg?.user);
    }
    if (sub === 'mode' && this.phase === 'lobby') {
      if (!arg) return this.say(this.#modeHelp());
      return this.openLobby(this.manifest.id, arg, msg?.user);
    }
    if (sub === 'vote') return this.startGameVote();
    if (sub === 'start') return this.phase === 'lobby' ? this.start() : null;
    if (sub === 'stop') return this.stop();
    if (sub === 'crowd' && this.phase === 'lobby') return this.setCrowdSeat(arg);
    if (sub === 'bot' && this.phase === 'lobby') return this.setBotSeat(arg);
    if (sub === 'bots' && this.phase === 'lobby') return this.setBotFill(arg);
    if (sub === 'stats') return this.#statsAdmin(arg);
    if (this.phase === 'lobby' && this.module?.adminCommand?.(sub, arg, {
      say: (t) => this.say(t),
      prefix: this.config.prefix,
      refresh: () => this.emit('lobbyInfo'),
    })) return;
    this.say(`Board games: !bg play <${this.registry.list.map((m) => m.id).join('|')}> [mode], !bg mode <mode>, !bg vote, !bg start, !bg stop, !bg crowd <seat>, !bg bot <seat>, !bg bots <total seats|0>, !bg stats reset [game] confirm, !bg menu`);
  }

  say(text) {
    this.emit('toast', text);
    if (this.bridge.capabilities.sendChat) this.bridge.sendChat(text).catch?.(() => {});
  }

  // ───────────────────────────── menu ─────────────────────────────

  toMenu() {
    if (this.phase === 'playing') this.#cancelPrediction();
    this.#clearTimer();
    this.#teardownGame();
    this.phase = 'menu';
    this.gameVote = null;
    this.emit('phase', this.phase);
  }

  startGameVote() {
    if (this.phase !== 'menu') this.toMenu();
    const options = this.registry.list.filter((m) => this.registry.isPlayable(m, this.bridge.capabilities));
    if (options.length === 0) return this.say('No playable games installed.');
    if (options.length === 1) return this.openLobby(options[0].id);
    this.gameVote = { options };
    this.votes.clear();
    const token = ++this.#token;
    this.emit('gameVote', { options, endsAt: Date.now() + this.config.voteSeconds * 1000, total: this.config.voteSeconds });
    this.say(`Vote for the next game: ${options.map((m, i) => `!${i + 1} ${m.name}`).join(' · ')}`);
    this.#setTimer(this.config.voteSeconds * 1000, () => {
      if (token !== this.#token) return;
      const winner = this.#tally(options.length) ?? 0;
      this.gameVote = null;
      this.openLobby(options[winner].id);
    });
  }

  // ───────────────────────────── lobby ─────────────────────────────

  // modeId: one of manifest.modes (default: the first). byUser: who opened it — if that's the
  // broadcaster and the mode reserves a seat for them, they're seated right away.
  async openLobby(gameId, modeId = null, byUser = null) {
    const manifest = this.registry.get(gameId);
    if (!manifest) return this.say(`Unknown game "${gameId}".`);
    if (!this.registry.isPlayable(manifest, this.bridge.capabilities)) {
      return this.say(`${manifest.name} needs ${manifest.needs.join(', ')}, which the current connection can't provide.`);
    }
    this.#clearTimer();
    this.#teardownGame();
    this.manifest = manifest;
    this.module = await this.registry.load(gameId);
    const modes = manifest.modes ?? [];
    this.mode = modes.find((m) => m.id === modeId) ?? modes[0] ?? null;
    // Games that need data (e.g. trivia questions) start loading while the lobby fills.
    try { this.module.preload?.({ manifest, mode: this.mode }); } catch (err) { console.warn('[session] preload failed', err); }
    if (modeId && this.mode?.id !== modeId) this.say(`Unknown mode "${modeId}" — using ${this.mode?.name ?? 'the default'}. ${this.#modeHelp()}`);
    this.seats = manifest.seats.map((s) => {
      const role = this.mode?.seats?.[s.id];
      const occupant = role === 'host' ? { type: 'reserved', role: 'host' } : role === 'crowd' ? { type: 'crowd' } : null;
      return { ...s, occupant };
    });
    this.entrants.clear();
    // Bots fill empty seats until this many seats are taken (games with many seats default lower).
    this.botFillTo = this.config.fillBots ? (manifest.players.botFillTo ?? manifest.players.max) : 0;
    this.phase = 'lobby';
    this.lobbyEndsAt = null;
    this.emit('phase', this.phase);
    this.#emitSeats();
    this.#emitEntrants();
    const p = this.config.prefix;
    const how = this.#isDraw() ? `Type ${p}join to enter the draw` : `Type ${p}join to play (or ${p}join ${manifest.seats.find((x) => !x.occupant)?.id ?? manifest.seats[0].id})`;
    this.say(`${manifest.name}${this.mode ? ` — ${this.mode.name}` : ''} lobby is open! ${how}.`);
    const host = this.#hostSeat();
    if (host) {
      if (byUser?.isBroadcaster) this.join(byUser);
      else this.say(`Streamer: type ${p}join to take ${host.name}.`);
    }
  }

  #isDraw() { return this.mode?.entry === 'draw'; }
  #hostSeat() { return this.seats.find((s) => s.occupant?.type === 'reserved' && s.occupant.role === 'host') ?? null; }
  #modeHelp() {
    const modes = this.manifest?.modes ?? [];
    return modes.length ? `Modes: ${modes.map((m) => `${m.id} (${m.name})`).join(', ')}` : 'This game has no modes.';
  }

  join(user, wanted) {
    if (this.phase !== 'lobby') return;
    if (this.#seatOf(user) !== -1) return;
    // The seat reserved for the streamer
    const host = this.#hostSeat();
    if (host && user.isBroadcaster) {
      host.occupant = { type: 'human', user, host: true };
      this.entrants.delete(user.id);
      this.say(`${user.name} takes ${host.name}!`);
      this.#emitSeats();
      this.#emitEntrants();
      this.#lobbyCountdown();
      return;
    }
    // Draw modes: collect entrants, seats are drawn at random when the lobby closes
    if (this.#isDraw()) {
      if (this.entrants.has(user.id)) return;
      this.entrants.set(user.id, user);
      this.#emitEntrants();
      this.#lobbyCountdown();
      return;
    }
    const free = this.seats.map((s, i) => [s, i]).filter(([s]) => !s.occupant || s.occupant.type === 'bot');
    if (free.length === 0) return;
    let pick = free.find(([s]) => wanted && (s.id === wanted || s.name.toLowerCase() === wanted));
    pick ??= free[0];
    pick[0].occupant = { type: 'human', user };
    this.say(`${user.name} joined as ${pick[0].name}.`);
    this.#emitSeats();
    this.#lobbyCountdown();
  }

  leave(user) {
    if (this.phase === 'lobby' && this.entrants.delete(user.id)) this.#emitEntrants();
    const i = this.#seatOf(user);
    if (i === -1) return;
    if (this.phase === 'lobby') {
      this.seats[i].occupant = this.seats[i].occupant.host ? { type: 'reserved', role: 'host' } : null;
      this.#emitSeats();
    } else if (this.phase === 'playing') {
      this.seats[i].occupant = { type: 'bot', replaced: user.name };
      this.say(`${user.name} left — a bot takes over ${this.seats[i].name}.`);
      this.#emitSeats();
      if (this.decision?.seat === this.#gameSeatIndex(i)) this.#runDecision();
    }
  }

  setCrowdSeat(arg) {
    const seat = this.seats.find((s) => s.id === arg) ?? this.seats.find((s) => !s.occupant);
    if (!seat) return;
    seat.occupant = { type: 'crowd' };
    this.say(`${seat.name} is played by chat vote — everyone not seated can vote with ${this.config.prefix}1, ${this.config.prefix}2, …`);
    this.#emitSeats();
    this.#lobbyCountdown();
  }

  // "!bg bots 6" → bots fill up to 6 seats in total; "!bg bots 0" → no bots.
  setBotFill(arg) {
    const n = Number.parseInt(arg, 10);
    if (Number.isNaN(n)) return this.say(`Bots fill up to ${this.botFillTo} seats. Change with ${this.config.prefix}bg bots <number>.`);
    this.botFillTo = Math.max(0, Math.min(n, this.manifest.players.max));
    this.say(this.botFillTo ? `Bots will fill up to ${this.botFillTo} seats.` : 'No bots this game.');
    this.#emitSeats();
  }

  setBotSeat(arg) {
    const seat = this.seats.find((s) => s.id === arg) ?? this.seats.find((s) => !s.occupant);
    if (!seat) return;
    seat.occupant = { type: 'bot' };
    this.#emitSeats();
  }

  #lobbyCountdown() {
    const taken = this.seats.filter((s) => s.occupant && s.occupant.type !== 'reserved').length;
    const full = !this.#isDraw() && taken >= this.manifest.players.max;
    const secs = full ? this.config.fullStartSeconds : this.config.lobbySeconds;
    const endsAt = Date.now() + secs * 1000;
    // Restart only when it gets shorter (or wasn't running): late joiners don't reset the clock.
    if (this.lobbyEndsAt && this.lobbyEndsAt <= endsAt) return;
    this.lobbyEndsAt = endsAt;
    this.emit('lobbyTimer', { endsAt, total: secs });
    const token = ++this.#token;
    this.#setTimer(secs * 1000, () => token === this.#token && this.start());
    // "⏳ 10 s left…" in chat — skipped when the countdown is too short for it to make sense
    for (const before of this.config.lobbyReminders ?? []) {
      if (secs - before < 8) continue;
      this.#reminders.push(this.sched.setTimeout(() => {
        if (token === this.#token && this.phase === 'lobby') this.say(this.#reminderText(before));
      }, (secs - before) * 1000));
    }
  }

  #reminderText(secondsLeft) {
    const p = this.config.prefix;
    const name = `${this.manifest.name}${this.mode ? ` (${this.mode.name})` : ''}`;
    let text;
    if (this.#isDraw()) {
      text = `⏳ ${secondsLeft}s left to enter ${name}! Type ${p}join (${this.entrants.size} entered)`;
    } else {
      const taken = this.seats.filter((s) => s.occupant && s.occupant.type !== 'reserved').length;
      text = `⏳ ${secondsLeft}s left to join ${name}! Type ${p}join (${taken}/${this.manifest.players.max} seats taken)`;
    }
    if (this.#hostSeat()) text += ` · Streamer: type ${p}join`;
    return text;
  }

  // ───────────────────────────── game ─────────────────────────────

  async start() {
    if (this.phase !== 'lobby' || this.#starting) return;
    this.#clearTimer();
    const host = this.#hostSeat();
    if (host) {
      this.lobbyEndsAt = null;
      return this.say(`Waiting for the streamer — type ${this.config.prefix}join to take ${host.name}.`);
    }
    if (this.#isDraw()) this.#drawEntrants();
    const humans = this.seats.filter((s) => s.occupant && s.occupant.type !== 'bot').length;
    if (humans < this.config.minHumans) {
      this.lobbyEndsAt = null;
      return this.say(`Need at least ${this.config.minHumans} player(s) — type ${this.config.prefix}join!`);
    }
    let taken = this.seats.filter((s) => s.occupant).length;
    for (const s of this.seats) {
      if (taken >= Math.max(this.botFillTo, this.manifest.players.min)) break;
      if (!s.occupant && (this.botFillTo > 0 || taken < this.manifest.players.min)) { s.occupant = { type: 'bot' }; taken++; }
    }
    let active = this.seats.filter((s) => s.occupant);
    if (active.length < this.manifest.players.min) {
      this.lobbyEndsAt = null;
      return this.say(`${this.manifest.name} needs at least ${this.manifest.players.min} players.`);
    }

    this.activeSeatIdx = this.seats.map((s, i) => (s.occupant ? i : -1)).filter((i) => i !== -1);
    // Everyone seated as a human now counts as having played, even if they leave later.
    this.participants = this.seats.filter((s) => s.occupant?.type === 'human').map((s) => ({ id: s.occupant.user.id, name: s.occupant.user.name }));
    this.rng = createRng();
    const rules = { ...(this.manifest.defaultRules ?? {}), ...(this.mode?.rules ?? {}) };
    this.rules = rules;
    // Optional async setup (e.g. waiting for trivia questions). Never blocks for long.
    let ctx = null;
    if (this.module.prepare) {
      this.#starting = true;
      try {
        ctx = await withTimeout(this.module.prepare({ manifest: this.manifest, mode: this.mode, rules }), 15000, 'game setup');
      } catch (err) { console.error('[session] prepare failed', err); }
      this.#starting = false;
      if (this.phase !== 'lobby') return; // stopped while loading
    }
    // Hosting on WiFi: a game whose setup data can't be rebuilt on other phones (trivia's live
    // question bank) records what it draws, and the records travel with each move.
    this.#lanRecords = [];
    if (this.lanHost && this.module.lan?.hostCtx) ctx = this.module.lan.hostCtx(ctx, (r) => { this.#lanRecords.push(r); return r; });
    const rngStart = this.rng.getState?.();
    this.game = this.module.createGame({
      seats: this.activeSeatIdx.map((i) => this.seats[i].id),
      rng: this.rng,
      rules,
      ctx: ctx ?? null,
    });
    if (this.lanHost) {
      this.emit('lanStart', {
        gameId: this.manifest.id,
        modeId: this.mode?.id ?? null,
        rngState: rngStart,
        rules,
        activeSeatIdx: this.activeSeatIdx,
        seats: this.seats,
        ctxSpec: this.module.lan?.spec?.(ctx) ?? null,
        records: this.#lanRecords.splice(0),
      });
    }
    this.phase = 'playing';
    this.emit('phase', this.phase);
    this.#emitSeats();
    this.#openPrediction(humans);
    this.#busy = true;
    try {
      await withTimeout(this.view?.mount?.(this.module, this.game, this.activeSeatIdx.map((i) => this.seats[i])), 20000, 'board intro');
    } catch (err) { console.error('[session] view mount failed', err); }
    this.#busy = false;
    if (this.phase === 'playing') this.#nextDecision();
  }

  // Fills open seats with randomly drawn entrants.
  #drawEntrants() {
    const pool = [...this.entrants.values()].filter((u) => this.#seatOf(u) === -1);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const drawn = [];
    for (const seat of this.seats) {
      if (seat.occupant || pool.length === 0) continue;
      const user = pool.shift();
      seat.occupant = { type: 'human', user };
      drawn.push(`${user.name} (${seat.name})`);
    }
    if (drawn.length) this.say(`🎲 Drawn from ${this.entrants.size} entr${this.entrants.size === 1 ? 'y' : 'ies'}: ${drawn.join(' vs ')}!`);
    this.entrants.clear();
    this.#emitEntrants();
    this.#emitSeats();
  }

  stop() {
    if (this.phase === 'playing') {
      this.#cancelPrediction();
      this.say('Game stopped.');
    }
    this.toMenu();
  }

  #teardownGame() {
    this.#token++;
    if (this.game) this.view?.unmount?.();
    this.game = null;
    this.decision = null;
    this.votes.clear();
  }

  #nextDecision() {
    if (this.phase !== 'playing') return;
    const d = this.game.decision();
    if (!d) return this.#finish();
    this.decision = d;
    this.votes.clear();
    this.#runDecision();
  }

  // (Re)starts whatever waits on the current decision: bot think time, human timer or crowd vote.
  #runDecision() {
    const d = this.decision;
    const seat = this.seats[this.activeSeatIdx[d.seat]];
    const occ = seat.occupant;
    const token = ++this.#token;
    this.#clearTimer();
    const later = (ms, fn) => this.#setTimer(ms, () => token === this.#token && !this.#busy && fn());
    // Options can be listed but disabled (e.g. a full column), so numbers stay stable.
    // Hidden options (shortcuts like Jazzy Dice's !keep) don't count as choices on screen.
    const enabled = d.options.map((o, i) => (o.disabled || o.hidden ? -1 : i)).filter((i) => i !== -1);

    let waitMs;
    if (occ.type === 'bot') {
      waitMs = this.config.botDelayMs;
      later(waitMs, () => this.#apply(this.game.botChoice()));
    } else if (enabled.length === 1 && (d.kind !== 'roll' || this.config.autoRoll)) {
      waitMs = d.kind === 'roll' ? this.config.botDelayMs : this.config.autoSingleMoveMs;
      later(waitMs, () => this.#apply(enabled[0]));
    } else if (occ.type === 'crowd') {
      // a decision can ask for more time (e.g. reading a trivia question)
      waitMs = Math.max(this.config.voteSeconds, d.seconds ?? 0) * 1000;
      later(waitMs, () => this.#apply(this.#tally(d.options.length) ?? this.#timeoutChoice()));
    } else {
      waitMs = (d.seconds ?? this.config.turnSeconds) * 1000;
      later(waitMs, () => {
        occ.afk = (occ.afk ?? 0) + 1;
        if (occ.afk >= this.config.afkLimit) {
          this.say(`${occ.user.name} seems to be away — a bot takes over ${seat.name}.`);
          seat.occupant = { type: 'bot', replaced: occ.user.name };
          this.#emitSeats();
        }
        this.#apply(this.#timeoutChoice());
      });
    }
    this.emit('decision', {
      decision: d,
      seat,
      occupant: seat.occupant,
      endsAt: Date.now() + waitMs,
      total: waitMs / 1000,
    });
    this.view?.decision?.(d, seat);
  }

  // What happens when time runs out: the game may decide (e.g. a trivia answer counts as wrong),
  // otherwise the bot plays the move.
  #timeoutChoice() {
    return this.game.timeoutChoice?.() ?? this.game.botChoice();
  }

  #playerInput(user, cmd) {
    const d = this.decision;
    if (!d || this.#busy) return;
    const seatIdx = this.activeSeatIdx[d.seat];
    const occ = this.seats[seatIdx].occupant;
    let index = -1;
    if (cmd.kind === 'choose') {
      index = cmd.index - 1;
      if (d.options[index]?.hidden) return; // hidden options are only reachable through game.command
    } else {
      // A game can map its own commands (with arguments) to an option, e.g. "!keep 135".
      index = this.game.command?.(cmd.alias, cmd.arg) ?? -1;
      if (index < 0) index = d.options.findIndex((o) => o.alias === cmd.alias && !o.hidden);
    }
    if (index < 0 || index >= d.options.length || d.options[index].disabled) return;

    if (occ.type === 'human' && occ.user.id === user.id) {
      occ.afk = 0;
      this.#apply(index);
    } else if (occ.type === 'crowd' && this.#seatOf(user) === -1) {
      this.#castVote(user, index, d.options.length);
    }
  }

  #castVote(user, index, count) {
    if (index < 0 || index >= count) return;
    this.votes.set(user.id, index);
    const tally = new Array(count).fill(0);
    for (const v of this.votes.values()) tally[v]++;
    this.emit('votes', tally);
  }

  #tally(count) {
    if (this.votes.size === 0) return null;
    const tally = new Array(count).fill(0);
    for (const v of this.votes.values()) tally[v]++;
    const best = Math.max(...tally);
    // ties → random among the tied options
    const tied = tally.map((n, i) => (n === best ? i : -1)).filter((i) => i !== -1);
    return tied[Math.floor(Math.random() * tied.length)];
  }

  async #apply(index) {
    if (this.#busy || this.phase !== 'playing') return;
    this.#busy = true;
    this.#token++;
    this.#clearTimer();
    const d = this.decision;
    this.decision = null;
    this.emit('decision', null);
    let result;
    const rngState = this.rng?.getState?.();
    this.#lanRecords = [];
    try {
      result = this.game.apply(index);
      if (this.lanHost) this.emit('lanApply', { index, rngState, records: this.#lanRecords.splice(0) });
    } catch (err) {
      // Rejected move: restore the turn so the game never stalls.
      console.error('[session] game.apply failed', err);
      this.#busy = false;
      this.decision = d;
      this.#runDecision();
      return;
    }
    const seat = this.seats[this.activeSeatIdx[d.seat]];
    for (const line of result.log ?? []) this.emit('log', { seat, text: line });
    try {
      this.emit('gameEvents', result.events ?? []);
      await withTimeout(this.view?.present?.(result.events ?? [], this.game), 15000, 'move animation');
    } catch (err) { console.error('[session] view present failed', err); }
    this.#busy = false;
    this.#nextDecision();
  }

  #finish() {
    const ranking = this.game.ranking(); // game seat indices, winner first
    const draw = this.game.isDraw?.() === true;
    const winner = this.seats[this.activeSeatIdx[ranking[0]]];
    this.phase = 'over';
    this.emit('phase', this.phase);
    this.emit('gameOver', { winner: draw ? null : winner, draw, ranking: ranking.map((g) => this.seats[this.activeSeatIdx[g]]) });
    if (this.follower) return; // the host records stats and decides what comes next
    this.#recordStats(winner, draw);
    if (draw) {
      this.say(`🤝 ${this.manifest.name} ends in a draw!${this.prediction ? ' Prediction refunded.' : ''}`);
      this.#cancelPrediction();
    } else {
      this.say(`🏆 ${this.#seatLabel(winner)} wins ${this.manifest.name}!`);
      this.#resolvePrediction(ranking[0]);
    }
    const token = ++this.#token;
    this.#setTimer(this.config.overSeconds * 1000, () => {
      if (token !== this.#token) return;
      if (this.config.afterGame === 'menu') this.toMenu();
      else this.openLobby(this.manifest.id, this.mode?.id);
    });
  }

  // ───────────────────────────── follower (joined phone) ─────────────────────────────
  // Each returns a promise; net/lan.js runs them strictly one after another.

  followMenu() {
    this.#clearTimer();
    this.#teardownGame();
    this.gameVote = null;
    if (this.phase !== 'menu') { this.phase = 'menu'; this.emit('phase', this.phase); }
  }

  async #followGame(gameId, modeId) {
    const manifest = this.registry.get(gameId);
    if (!manifest) throw new Error(`Unknown game "${gameId}" — is this app up to date?`);
    if (this.manifest?.id !== gameId || !this.module) {
      this.manifest = manifest;
      this.module = await this.registry.load(gameId);
    }
    this.mode = (manifest.modes ?? []).find((m) => m.id === modeId) ?? null;
  }

  async followLobby({ gameId, modeId, seats, botFillTo }) {
    if (this.phase === 'playing' || this.phase === 'over') this.#teardownGame();
    await this.#followGame(gameId, modeId);
    this.seats = seats;
    this.botFillTo = botFillTo ?? 0;
    if (this.phase !== 'lobby') { this.phase = 'lobby'; this.emit('phase', this.phase); }
    this.#emitSeats();
  }

  async followStart({ gameId, modeId, rngState, rules, activeSeatIdx, seats, ctxSpec, records = [] }) {
    this.#teardownGame();
    await this.#followGame(gameId, modeId);
    this.seats = seats;
    this.activeSeatIdx = activeSeatIdx;
    this.rules = rules;
    this.rng = createRng();
    this.rng.setState(rngState);
    this.#lanRecords = [...records];
    const ctx = this.module.lan?.clientCtx?.(ctxSpec, () => this.#lanRecords.shift()) ?? null;
    this.game = this.module.createGame({ seats: activeSeatIdx.map((i) => seats[i].id), rng: this.rng, rules, ctx });
    this.phase = 'playing';
    this.emit('phase', this.phase);
    this.#emitSeats();
    this.#busy = true;
    try {
      await withTimeout(this.view?.mount?.(this.module, this.game, activeSeatIdx.map((i) => seats[i])), 20000, 'board intro');
    } catch (err) { console.error('[session] view mount failed', err); }
    this.#busy = false;
  }

  // The host started waiting for a decision (ms: time left on the host's clock).
  followDecision({ ms, total }) {
    if (this.phase !== 'playing' || !this.game) return;
    const d = this.game.decision();
    if (!d) return;
    this.decision = d;
    const seat = this.seats[this.activeSeatIdx[d.seat]];
    this.emit('decision', { decision: d, seat, occupant: seat.occupant, endsAt: Date.now() + Math.max(0, ms), total });
    this.view?.decision?.(d, seat);
  }

  // The host applied option `index`. Throws if this copy of the game has drifted apart.
  async followApply({ index, rngState, records = [] }) {
    if (this.phase !== 'playing' || !this.game) return;
    const d = this.game.decision();
    if (!d) throw new Error('out of sync: no decision here');
    if (rngState != null) this.rng.setState(rngState);
    this.#lanRecords.push(...records);
    this.decision = null;
    this.emit('decision', null);
    const result = this.game.apply(index);
    const seat = this.seats[this.activeSeatIdx[d.seat]];
    for (const line of result.log ?? []) this.emit('log', { seat, text: line });
    this.#busy = true;
    try {
      this.emit('gameEvents', result.events ?? []);
      await withTimeout(this.view?.present?.(result.events ?? [], this.game), 15000, 'move animation');
    } catch (err) { console.error('[session] view present failed', err); }
    this.#busy = false;
    if (!this.game.decision()) this.#finish();
  }

  // Seats changed during a game (someone left and a bot took over).
  followSeats(seats) {
    this.seats = seats;
    this.#emitSeats();
  }

  // ───────────────────────────── stats ─────────────────────────────

  #recordStats(winnerSeat, draw) {
    if (!this.stats || !this.participants?.length) return;
    const o = winnerSeat?.occupant;
    // A player who left was replaced by a bot: the win goes to nobody.
    const winnerId = !draw && o?.type === 'human' ? o.user.id : null;
    this.stats.record({ gameId: this.manifest.id, players: this.participants, winnerId, draw });
    if (winnerId) {
      const s = this.stats.data.players[winnerId];
      if (s?.streak >= 2) this.say(`🔥 ${s.name} is on a ${s.streak}-win streak!`);
    }
    this.emit('stats', this.statsView());
  }

  // What the game select screen shows: all pages + the current one.
  statsView() {
    if (!this.stats) return null;
    const pages = this.stats.pages(this.registry.list);
    this.statsIndex = Math.min(this.statsIndex, pages.length - 1);
    return { pages, index: this.statsIndex };
  }

  // !bgstats → next page (game select screen); !bgstats <game|overall|streak> → that page;
  // !bgstats me → your own numbers in chat.
  #statsCommand(user, arg) {
    if (!this.stats) return;
    if (arg === 'me') {
      return this.say(this.stats.summary(user.id, this.registry.list) ?? `${user.name}: no finished games yet. Play one!`);
    }
    if (this.phase !== 'menu') return;
    const now = Date.now();
    if (now - this.statsTurnedAt < this.config.statsCooldownMs) return; // a flood of !bgstats only turns once
    this.statsTurnedAt = now;
    const pages = this.stats.pages(this.registry.list);
    const jump = arg ? pages.findIndex((p) => p.id === arg) : -1;
    this.statsIndex = jump >= 0 ? jump : (this.statsIndex + 1) % pages.length;
    this.emit('stats', { pages, index: this.statsIndex });
  }

  // !bg stats reset confirm | !bg stats reset <game> confirm
  #statsAdmin(arg) {
    if (!this.stats) return;
    const words = (arg ?? '').split(/\s+/).filter(Boolean);
    if (words[0] !== 'reset') return this.say(`Stats: ${this.config.prefix}bgstats (next page), ${this.config.prefix}bgstats me, ${this.config.prefix}bg stats reset [game] confirm`);
    const confirmed = words.at(-1) === 'confirm';
    const gameId = words.length >= 2 && words[1] !== 'confirm' ? words[1] : null;
    if (gameId && !this.registry.get(gameId)) return this.say(`Unknown game "${gameId}".`);
    const what = gameId ? `the ${this.registry.get(gameId).name} leaderboard` : 'ALL viewer stats';
    if (!confirmed) return this.say(`This deletes ${what}. Type ${this.config.prefix}bg stats reset ${gameId ? `${gameId} ` : ''}confirm to do it.`);
    this.stats.reset(gameId);
    this.statsIndex = 0;
    this.say(`Deleted ${what}.`);
    this.emit('stats', this.statsView());
  }

  // ───────────────────────────── predictions ─────────────────────────────

  #openPrediction(humans) {
    if (!this.config.predictions || !this.bridge.capabilities.predictions || humans < 2) return;
    const seats = this.activeSeatIdx.map((i) => this.seats[i]);
    if (seats.length < 2 || seats.length > 10) return;
    const outcomes = seats.map((s) => this.#seatLabel(s).slice(0, 25));
    this.prediction = { open: true };
    this.bridge.prediction
      .create(`Who wins ${this.manifest.name}?`.slice(0, 45), outcomes, Math.max(30, this.config.predictionSeconds))
      .catch((err) => { console.warn('[session] prediction create failed', err); this.prediction = null; });
  }

  #resolvePrediction(gameSeat) {
    if (!this.prediction) return;
    this.prediction = null;
    this.bridge.prediction.resolve(gameSeat).catch((err) => console.warn('[session] prediction resolve failed', err));
  }

  #cancelPrediction() {
    if (!this.prediction) return;
    this.prediction = null;
    this.bridge.prediction.cancel().catch((err) => console.warn('[session] prediction cancel failed', err));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  #seatLabel(seat) {
    const o = seat.occupant;
    if (o?.type === 'human') return `${o.user.name} (${seat.name})`;
    if (o?.type === 'reserved') return `Streamer (${seat.name})`;
    if (o?.type === 'crowd') return `Chat (${seat.name})`;
    return `Bot (${seat.name})`;
  }

  #seatOf(user) {
    return this.seats.findIndex((s) => s.occupant?.type === 'human' && s.occupant.user.id === user.id);
  }

  #gameSeatIndex(seatIdx) {
    return this.activeSeatIdx?.indexOf(seatIdx) ?? -1;
  }

  #emitEntrants() {
    this.emit('entrants', [...this.entrants.values()]);
  }

  #emitSeats() {
    this.emit('seats', this.seats.map((s) => ({ ...s, label: s.occupant ? this.#seatLabel(s) : null })));
  }

  #setTimer(ms, fn) {
    this.#clearTimer();
    this.#timer = this.sched.setTimeout(fn, ms);
  }

  #clearTimer() {
    if (this.#timer != null) this.sched.clearTimeout(this.#timer);
    this.#timer = null;
    for (const r of this.#reminders) this.sched.clearTimeout(r);
    this.#reminders = [];
  }
}
