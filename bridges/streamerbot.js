// Streamer.bot bridge via its WebSocket server (default ws://127.0.0.1:8080/).
// Docs: https://docs.streamer.bot/api/servers/websocket/requests
//
// Chat comes from the Twitch.ChatMessage event. Everything outgoing runs one of
// two Streamer.bot actions through DoAction (setup: docs/STREAMERBOT.md):
//   "BoardGames · Bridge"  — C# (streamerbot/BoardGamesBridge.cs), args: op + op-specific args
//   "BoardGames · Resolve" — built-in "Resolve Last Prediction" sub-action, index %winnerIndex0%
// All args are sent as strings.

import { Bridge, first } from './bridge.js';

export const SB_ACTIONS = {
  bridge: 'BoardGames · Bridge',
  resolve: 'BoardGames · Resolve',
};

export class StreamerBotBridge extends Bridge {
  capabilities = { chat: true, sendChat: true, whisper: true, predictions: true, extension: false };

  constructor(options) {
    super(options);
    this.pending = new Map();
    this.outcomes = [];
    this.prediction = {
      create: (title, outcomes, seconds) => {
        this.outcomes = outcomes.map((o) => o.replace(/\|/g, '/'));
        return this.op('predictionCreate', { title, outcomes: this.outcomes.join('|'), seconds });
      },
      lock: () => this.op('predictionLock'),
      resolve: (index) => this.doAction(SB_ACTIONS.resolve, {
        winnerIndex0: index, winnerIndex: index + 1, winnerTitle: this.outcomes[index] ?? '',
      }),
      cancel: () => this.op('predictionCancel'),
    };
  }

  async connect() {
    const { host = '127.0.0.1', port = 8080, endpoint = '/' } = this.options;
    this.status('connecting', `${host}:${port}`);
    const ws = (this.ws = new WebSocket(`ws://${host}:${port}${endpoint}`));
    ws.onopen = () => {
      // If the server has authentication enabled it sends a Hello with an
      // auth challenge first; auth isn't implemented yet → turn it off for now.
      this.retry = 0;
      this.request({ request: 'Subscribe', events: { Twitch: ['ChatMessage'] } })
        .then(() => this.status('connected', 'Streamer.bot'))
        .catch((err) => this.status('error', err.message));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.status === 'error' ? reject(new Error(msg.error ?? 'Streamer.bot error')) : resolve(msg);
        return;
      }
      if (msg.request === 'Hello' && msg.authentication) {
        this.status('error', 'Streamer.bot WebSocket authentication is on — disable it for now');
        return;
      }
      if (msg.event?.source === 'Twitch' && msg.event?.type === 'ChatMessage') {
        const chat = normalizeSbChat(msg.data);
        if (chat) this.emit('chat', chat);
      }
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.status('error', 'is the Streamer.bot WebSocket server started?');
  }

  request(body) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Streamer.bot not connected'));
    const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...body, id }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Streamer.bot request ${body.request} timed out`));
      }, 5000);
    });
  }

  doAction(name, args = {}) {
    const strArgs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]));
    return this.request({ request: 'DoAction', action: { name }, args: strArgs });
  }

  op(op, args = {}) { return this.doAction(SB_ACTIONS.bridge, { op, ...args }); }

  sendChat(text) { return this.op('chat', { message: text }); }
  whisper(user, text) { return this.op('whisper', { user, message: text }); }
}

// Handles the current payload (data.user / data.text) and the older one (data.message.*).
// Streamer.bot roles: 1 viewer, 2 VIP, 3 moderator, 4 broadcaster.
export function normalizeSbChat(data) {
  if (!data) return null;
  const old = typeof data.message === 'object' ? data.message : null;
  const text = first(data.text, old?.message);
  if (typeof text !== 'string') return null;
  const u = data.user ?? {};
  const login = first(u.login, old?.username, 'unknown');
  const id = String(first(u.id, old?.userId, login));
  const role = Number(first(u.role, old?.role, 1));
  const isBroadcaster = role >= 4 || (data.broadcaster?.id != null && String(data.broadcaster.id) === id);
  return {
    platform: 'twitch',
    text,
    user: { id, login, name: first(u.name, old?.displayName, login), isBroadcaster, isMod: isBroadcaster || role >= 3 },
  };
}
