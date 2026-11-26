// The Session runs everything game-independent: menu/game vote, lobby & seats,
// turn timers, crowd votes, bots taking over for AFK players, predictions,
// and talking to chat. Games only provide rules (see docs/GAME_API.md).
//
// Phases: 'menu' → 'lobby' → 'playing' → 'over' → back to 'lobby' (rematch) or 'menu'.

import { Emitter } from './emitter.js';
import { parseCommand } from './commands.js';
import { createRng } from './rng.js';

export const CORE_VERSION = '1.0.0';

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
  afterGame: 'menu',       // 'menu' (back to game select) or 'lobby' (rematch of the same game)
};

export class Session extends Emitter {
  constructor({ bridge, registry, view = null, config = {}, scheduler = globalThis }) {
    super();
    this.bridge = bridge;
    this.registry = registry;
    this.view = view;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sched = scheduler;

    this.phase = 'menu';
    this.manifest = null;
    this.module = null;
    this.game = null;
    this.seats = [];
    this.decision = null;
    this.votes = new Map();   // userId → option index (crowd seat or game vote)
    this.gameVote = null;     // { options: manifest[] } while a game vote runs
    this.prediction = null;   // { seatOrder: seatIndex[] } while one is open
    this.#busy = false;

    bridge.on('chat', (msg) => this.handleChat(msg));
  }

  #busy;
  #timer = null;
  #token = 0; // invalidates stale timers/votes whenever the decision changes

  // ───────────────────────────── chat ─────────────────────────────

  handleChat(msg) {
    const cmd = parseCommand(msg, this.config.prefix);
    if (!cmd) return;
    if (cmd.kind === 'admin') return this.#admin(cmd, msg);

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

  #admin(cmd) {
    const { sub, arg } = cmd;
    if (sub === 'menu') return this.toMenu();
    if (sub === 'play' && arg) return this.openLobby(arg);
    if (sub === 'vote') return this.startGameVote();
    if (sub === 'start') return this.phase === 'lobby' ? this.start() : null;
    if (sub === 'stop') return this.stop();
    if (sub === 'crowd' && this.phase === 'lobby') return this.setCrowdSeat(arg);
    if (sub === 'bot' && this.phase === 'lobby') return this.setBotSeat(arg);
    if (sub === 'bots' && this.phase === 'lobby') return this.setBotFill(arg);
    this.say(`Board games: !bg play <${this.registry.list.map((m) => m.id).join('|')}>, !bg vote, !bg start, !bg stop, !bg crowd <seat>, !bg bot <seat>, !bg bots <total seats|0>, !bg menu`);
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

  async openLobby(gameId) {
    const manifest = this.registry.get(gameId);
    if (!manifest) return this.say(`Unknown game "${gameId}".`);
    if (!this.registry.isPlayable(manifest, this.bridge.capabilities)) {
      return this.say(`${manifest.name} needs ${manifest.needs.join(', ')}, which the current connection can't provide.`);
    }
    this.#clearTimer();
    this.#teardownGame();
    this.manifest = manifest;
    this.module = await this.registry.load(gameId);
    this.seats = manifest.seats.map((s) => ({ ...s, occupant: null }));
    // Bots fill empty seats until this many seats are taken (games with many seats default lower).
    this.botFillTo = this.config.fillBots ? (manifest.players.botFillTo ?? manifest.players.max) : 0;
    this.phase = 'lobby';
    this.lobbyEndsAt = null;
    this.emit('phase', this.phase);
    this.#emitSeats();
    this.say(`${manifest.name} lobby is open! Type ${this.config.prefix}join to play (or ${this.config.prefix}join ${manifest.seats[0].id}).`);
  }

  join(user, wanted) {
    if (this.phase !== 'lobby') return;
    if (this.#seatOf(user) !== -1) return;
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
    const i = this.#seatOf(user);
    if (i === -1) return;
    if (this.phase === 'lobby') {
      this.seats[i].occupant = null;
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
    const taken = this.seats.filter((s) => s.occupant).length;
    const full = taken >= this.manifest.players.max;
    const secs = full ? this.config.fullStartSeconds : this.config.lobbySeconds;
    const endsAt = Date.now() + secs * 1000;
    // Restart only when it gets shorter (or wasn't running): late joiners don't reset the clock.
    if (this.lobbyEndsAt && this.lobbyEndsAt <= endsAt) return;
    this.lobbyEndsAt = endsAt;
    this.emit('lobbyTimer', { endsAt, total: secs });
    const token = ++this.#token;
    this.#setTimer(secs * 1000, () => token === this.#token && this.start());
  }

  // ───────────────────────────── game ─────────────────────────────

  async start() {
    if (this.phase !== 'lobby') return;
    this.#clearTimer();
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
    this.rng = createRng();
    this.game = this.module.createGame({
      seats: this.activeSeatIdx.map((i) => this.seats[i].id),
      rng: this.rng,
      rules: this.manifest.defaultRules ?? {},
    });
    this.phase = 'playing';
    this.emit('phase', this.phase);
    this.#emitSeats();
    this.#openPrediction(humans);
    this.#busy = true;
    try {
      await this.view?.mount?.(this.module, this.game, this.activeSeatIdx.map((i) => this.seats[i]));
    } catch (err) { console.error('[session] view mount failed', err); }
    this.#busy = false;
    if (this.phase === 'playing') this.#nextDecision();
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

    let waitMs;
    if (occ.type === 'bot') {
      waitMs = this.config.botDelayMs;
      later(waitMs, () => this.#apply(this.game.botChoice()));
    } else if (d.options.length === 1 && (d.kind !== 'roll' || this.config.autoRoll)) {
      waitMs = d.kind === 'roll' ? this.config.botDelayMs : this.config.autoSingleMoveMs;
      later(waitMs, () => this.#apply(0));
    } else if (occ.type === 'crowd') {
      waitMs = this.config.voteSeconds * 1000;
      later(waitMs, () => this.#apply(this.#tally(d.options.length) ?? this.game.botChoice()));
    } else {
      waitMs = this.config.turnSeconds * 1000;
      later(waitMs, () => {
        occ.afk = (occ.afk ?? 0) + 1;
        if (occ.afk >= this.config.afkLimit) {
          this.say(`${occ.user.name} seems to be away — a bot takes over ${seat.name}.`);
          seat.occupant = { type: 'bot', replaced: occ.user.name };
          this.#emitSeats();
        }
        this.#apply(this.game.botChoice());
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

  #playerInput(user, cmd) {
    const d = this.decision;
    if (!d || this.#busy) return;
    const seatIdx = this.activeSeatIdx[d.seat];
    const occ = this.seats[seatIdx].occupant;
    let index = -1;
    if (cmd.kind === 'choose') index = cmd.index - 1;
    else index = d.options.findIndex((o) => o.alias === cmd.alias);
    if (index < 0 || index >= d.options.length) return;

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
    return tally.indexOf(Math.max(...tally));
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
    try {
      result = this.game.apply(index);
    } catch (err) {
      console.error('[session] game.apply failed', err);
      this.#busy = false;
      return;
    }
    const seat = this.seats[this.activeSeatIdx[d.seat]];
    for (const line of result.log ?? []) this.emit('log', { seat, text: line });
    try {
      await this.view?.present?.(result.events ?? [], this.game);
    } catch (err) { console.error('[session] view present failed', err); }
    this.#busy = false;
    this.#nextDecision();
  }

  #finish() {
    const ranking = this.game.ranking(); // game seat indices, winner first
    const winner = this.seats[this.activeSeatIdx[ranking[0]]];
    this.phase = 'over';
    this.emit('phase', this.phase);
    this.emit('gameOver', { winner, ranking: ranking.map((g) => this.seats[this.activeSeatIdx[g]]) });
    this.say(`🏆 ${this.#seatLabel(winner)} wins ${this.manifest.name}!`);
    this.#resolvePrediction(ranking[0]);
    const token = ++this.#token;
    this.#setTimer(this.config.overSeconds * 1000, () => {
      if (token !== this.#token) return;
      if (this.config.afterGame === 'menu') this.toMenu();
      else this.openLobby(this.manifest.id);
    });
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
    if (o?.type === 'crowd') return `Chat (${seat.name})`;
    return `Bot (${seat.name})`;
  }

  #seatOf(user) {
    return this.seats.findIndex((s) => s.occupant?.type === 'human' && s.occupant.user.id === user.id);
  }

  #gameSeatIndex(seatIdx) {
    return this.activeSeatIdx?.indexOf(seatIdx) ?? -1;
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
  }
}
