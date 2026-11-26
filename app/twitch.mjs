// Twitch connection for the companion app (no dependencies, Node 22+ for the built-in WebSocket).
//
// Login: OAuth device code flow (https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow).
//   The streamer opens twitch.tv/activate, types a short code, done. Needs the client ID of a
//   Twitch app registered as a *Public* client; public clients refresh tokens without a secret.
// Accounts: the streamer (required: chat in, predictions) and optionally a bot account
//   that posts the game's chat messages. Without a bot, messages come from the streamer.
// Chat in:   EventSub WebSocket, channel.chat.message (streamer's token)
// Chat out:  Helix POST /chat/messages (bot token if connected, else streamer)
// Predictions: Helix /predictions (Affiliate or Partner channels only)

import { Emitter } from '../core/emitter.js';

export const SCOPES = ['user:read:chat', 'user:write:chat', 'channel:manage:predictions'];
export const BOT_SCOPES = ['user:write:chat'];
const ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';

// One logged-in Twitch account: device code login, token refresh, validation.
export class Account extends Emitter {
  constructor({ kind, scopes, store, clientId, fetch, log }) {
    super();
    Object.assign(this, { kind, scopes, store, clientId, fetch, log });
    this.auth = null;              // { access_token, refresh_token, login, user_id }
    this.pending = null;           // device code login in progress
  }

  get login() { return this.auth?.login ?? null; }
  get userId() { return this.auth?.user_id ?? null; }

  async load() {
    this.auth = await this.store.loadAuth(this.kind);
    return this.auth ? this.validate() : false;
  }

  // Returns { user_code, verification_uri, expires_in } right away; emits 'login' (ok) or 'loginFailed' later.
  async startLogin() {
    if (!this.clientId) throw new Error('No Twitch client ID configured');
    const res = await this.fetch(`${ID}/device`, { method: 'POST', body: form({ client_id: this.clientId, scopes: this.scopes.join(' ') }) });
    const dev = await res.json();
    if (!res.ok) throw new Error(dev.message ?? `Twitch said ${res.status}`);
    this.pending = dev;
    this.#poll(dev).catch((err) => { if (this.pending === dev) this.pending = null; this.emit('loginFailed', err.message); });
    return { user_code: dev.user_code, verification_uri: dev.verification_uri, expires_in: dev.expires_in };
  }

  async #poll(dev) {
    const until = Date.now() + dev.expires_in * 1000;
    let wait = (dev.interval ?? 5) * 1000;
    while (Date.now() < until && this.pending === dev) {
      await sleep(wait);
      if (this.pending !== dev) return;
      const res = await this.fetch(`${ID}/token`, {
        method: 'POST',
        body: form({ client_id: this.clientId, scopes: this.scopes.join(' '), device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        this.pending = null;
        this.auth = { access_token: body.access_token, refresh_token: body.refresh_token };
        if (await this.validate()) this.emit('login', this.auth);
        else this.emit('loginFailed', 'Twitch did not accept the new login');
        return;
      }
      const msg = String(body.message ?? '');
      if (msg.includes('slow_down')) wait += 5000;
      else if (!msg.includes('authorization_pending')) throw new Error(`login failed: ${msg || res.status}`);
    }
    if (this.pending === dev) throw new Error('login code expired, try again');
  }

  cancelLogin() { this.pending = null; }

  async logout() {
    this.pending = null;
    const token = this.auth?.access_token;
    this.auth = null;
    await this.store.saveAuth(null, this.kind);
    if (token) this.fetch(`${ID}/revoke`, { method: 'POST', body: form({ client_id: this.clientId, token }) }).catch(() => {});
  }

  // Checks the token (refreshing it if needed) and learns who it belongs to.
  // Returns false (and forgets the login) if it's no longer valid; throws if Twitch can't be reached.
  async validate() {
    if (!this.auth) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetch(`${ID}/validate`, { headers: { Authorization: `OAuth ${this.auth.access_token}` } });
      if (res.ok) {
        const v = await res.json();
        const missing = this.scopes.filter((s) => !v.scopes?.includes(s));
        Object.assign(this.auth, { login: v.login, user_id: v.user_id });
        await this.store.saveAuth(this.auth, this.kind);
        if (missing.length) this.log.warn(`[twitch] ${this.kind} token is missing scopes: ${missing.join(', ')} (log in again)`);
        return true;
      }
      if (res.status !== 401 || attempt > 0 || !(await this.refresh())) break;
    }
    await this.store.saveAuth(null, this.kind);
    this.auth = null;
    return false;
  }

  async refresh() {
    if (!this.auth?.refresh_token) return false;
    this.refreshing ??= (async () => {
      const res = await this.fetch(`${ID}/token`, {
        method: 'POST',
        body: form({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this.auth.refresh_token }),
      });
      if (!res.ok) return false;
      const body = await res.json();
      // Refresh tokens are single-use: always keep the new one.
      Object.assign(this.auth, { access_token: body.access_token, refresh_token: body.refresh_token ?? this.auth.refresh_token });
      await this.store.saveAuth(this.auth, this.kind);
      return true;
    })().catch(() => false).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async helix(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.auth) throw new Error(`${this.kind === 'bot' ? 'bot account' : 'Twitch'} not logged in`);
      const res = await this.fetch(`${HELIX}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.auth.access_token}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0 && (await this.refresh())) continue;
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`Twitch ${method} ${path.split('?')[0]}: ${data.message ?? res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }
    throw new Error('Twitch login expired');
  }
}

export class Twitch extends Emitter {
  // store: app/store.mjs (for the auth files); clientId: the Twitch app's client ID
  constructor({ store, clientId, fetch = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = console }) {
    super();
    Object.assign(this, { store, clientId, fetch, WebSocketImpl, log });
    const common = { store, clientId, fetch, log };
    this.main = new Account({ kind: 'main', scopes: SCOPES, ...common });
    this.bot = new Account({ kind: 'bot', scopes: BOT_SCOPES, ...common });
    this.state = { state: 'logged-out', detail: '', login: null };
    this.botState = { state: 'none', detail: '', login: null };
    this.prediction = null;        // { id, outcomes: [{ id, title }] }
    this.sent = [];                // recently sent { id, text, at }, to drop our own echoes
    this.closed = false;

    this.main.on('login', () => this.#afterMainLogin());
    this.main.on('loginFailed', (msg) => this.setState('logged-out', msg));
    this.bot.on('login', () => this.#checkBot());
    this.bot.on('loginFailed', (msg) => this.setBotState('none', msg));
  }

  get auth() { return this.main.auth; }

  setState(state, detail = '') {
    this.state = { state, detail, login: this.main.login };
    this.emit('state', this.state);
  }

  setBotState(state, detail = '') {
    this.botState = { state, detail, login: this.bot.login };
    this.emit('botState', this.botState);
  }

  async start() {
    if (!this.clientId) { this.setState('error', 'no Twitch client ID set up yet'); return; }
    try {
      if (await this.main.load()) this.#afterMainLogin();
      else this.setState('logged-out', '');
    } catch (err) {
      this.setState('error', `can't reach Twitch (${err.message}), retrying`);
      this.retryStart = setTimeout(() => this.start(), 30000);
      return;
    }
    try {
      if (await this.bot.load()) await this.#checkBot();
    } catch (err) {
      this.setBotState('error', `can't reach Twitch (${err.message})`);
    }
  }

  // ---------------- login / logout ----------------

  async login() {
    const code = await this.main.startLogin();
    this.setState('logging-in', `enter ${code.user_code} at ${code.verification_uri}`);
    return code;
  }

  async loginBot() {
    if (!this.main.auth) throw new Error('log in with your streaming account first');
    const code = await this.bot.startLogin();
    this.setBotState('logging-in', `enter ${code.user_code} at ${code.verification_uri}`);
    return code;
  }

  async logout() {
    clearInterval(this.validateTimer);
    this.#closeSocket();
    await this.main.logout();
    this.setState('logged-out');
  }

  async logoutBot() {
    await this.bot.logout();
    this.setBotState('none');
  }

  #afterMainLogin() {
    clearInterval(this.validateTimer);
    // Twitch asks apps to validate tokens hourly.
    this.validateTimer = setInterval(() => this.#revalidate(), 60 * 60 * 1000);
    this.validateTimer.unref?.();
    this.connectChat();
    if (this.bot.auth) this.#checkBot();
  }

  async #revalidate() {
    try {
      if (!(await this.main.validate())) { this.#closeSocket(); this.setState('logged-out', 'login expired, log in again'); }
      if (this.bot.auth && !(await this.bot.validate())) this.setBotState('none', 'bot login expired, connect it again');
    } catch { /* offline for a moment: try again next hour */ }
  }

  // The bot must be a different account than the streamer's.
  async #checkBot() {
    if (this.bot.userId && this.main.userId && this.bot.userId === this.main.userId) {
      await this.bot.logout();
      this.setBotState('none', `that was your streaming account (${this.main.login}). Open the link in a private/incognito window and log in as the bot there`);
      return;
    }
    this.setBotState('connected', '');
  }

  // ---------------- chat ----------------

  connectChat(url = EVENTSUB) {
    if (!this.main.auth || this.closed) return;
    this.setState('connecting', `#${this.main.login}`);
    const ws = new this.WebSocketImpl(url);
    const old = this.ws;
    this.ws = ws;
    ws.onmessage = (ev) => this.#onMessage(ws, old, ev).catch((err) => {
      this.log.error('[twitch]', err.message);
      this.setState('error', err.message);
    });
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced by a reconnect
      clearTimeout(this.keepalive);
      if (this.main.auth && !this.closed) {
        this.setState('connecting', 'chat connection lost, reconnecting');
        this.retry = Math.min((this.retry ?? 0) + 1, 6);
        this.reconnectTimer = setTimeout(() => this.connectChat(), 1000 * 2 ** (this.retry - 1));
      }
    };
    ws.onerror = () => {};
  }

  async #onMessage(ws, old, ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.metadata?.message_type;
    this.#armKeepalive(ws, msg.payload?.session?.keepalive_timeout_seconds);
    if (type === 'session_welcome') {
      if (old && old !== ws) old.close?.();
      if (this.reconnecting) {
        this.reconnecting = false; // session_reconnect: subscriptions carry over to the new URL
      } else {
        await this.main.helix('POST', '/eventsub/subscriptions', {
          type: 'channel.chat.message',
          version: '1',
          condition: { broadcaster_user_id: this.main.userId, user_id: this.main.userId },
          transport: { method: 'websocket', session_id: msg.payload.session.id },
        });
      }
      this.retry = 0;
      this.setState('connected', `#${this.main.login}`);
    } else if (type === 'session_reconnect') {
      this.reconnecting = true;
      this.connectChat(msg.payload.session.reconnect_url);
    } else if (type === 'notification' && msg.metadata.subscription_type === 'channel.chat.message') {
      const chat = normalizeChat(msg.payload.event, this.main.userId);
      if (chat && !this.#isEcho(msg.payload.event)) this.emit('chat', chat);
    } else if (type === 'revocation') {
      this.setState('error', `Twitch stopped chat events (${msg.payload?.subscription?.status}); log in again`);
    }
  }

  // No message for longer than the keepalive window → the connection is dead.
  #armKeepalive(ws, seconds) {
    if (seconds) this.keepaliveMs = (seconds + 10) * 1000;
    if (ws !== this.ws) return;
    clearTimeout(this.keepalive);
    if (!this.keepaliveMs) return;
    this.keepalive = setTimeout(() => { if (this.ws === ws) { this.reconnecting = false; ws.close(); } }, this.keepaliveMs);
  }

  #closeSocket() {
    clearTimeout(this.keepalive);
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  // Our own messages (streamer or bot account) come back as chat events; don't feed them to the game.
  #isEcho(event) {
    if (event.chatter_user_id !== this.main.userId && event.chatter_user_id !== this.bot.userId) return false;
    const now = Date.now();
    this.sent = this.sent.filter((s) => now - s.at < 15000);
    const i = this.sent.findIndex((s) => s.id === event.message_id || s.text === event.message?.text);
    if (i < 0) return false;
    this.sent.splice(i, 1);
    return true;
  }

  // Sends as the bot when one is connected, otherwise as the streamer.
  // If the bot can't post (banned, timed out, chat restrictions), the message goes out from the streamer instead.
  async sendChat(text) {
    const message = String(text).slice(0, 500);
    if (this.botState.state === 'connected' && this.bot.auth) {
      try {
        const r = await this.#send(this.bot, message);
        if (this.botState.detail) this.setBotState('connected', '');
        return r;
      } catch (err) {
        this.log.warn(`[twitch] bot couldn't post (${err.message}), sending from ${this.main.login} instead`);
        if (err.status === 401) this.setBotState('none', 'bot login expired, connect it again');
        else this.setBotState('connected', `last message failed (${err.message}), sent from your account instead`);
      }
    }
    return this.#send(this.main, message);
  }

  async #send(account, message) {
    const entry = { text: message, at: Date.now(), id: null };
    this.sent.push(entry);
    try {
      const data = await account.helix('POST', '/chat/messages', { broadcaster_id: this.main.userId, sender_id: account.userId, message });
      const result = data.data?.[0];
      entry.id = result?.message_id ?? null;
      if (result && !result.is_sent) throw new Error(`chat message dropped: ${result.drop_reason?.message ?? 'unknown reason'}`);
      return { ok: true, from: account.login };
    } catch (err) {
      this.sent = this.sent.filter((s) => s !== entry);
      throw err;
    }
  }

  // ---------------- predictions (always the streamer's account) ----------------

  async predict(action, { title, outcomes, seconds, index } = {}) {
    const id = this.main.userId;
    if (action === 'create') {
      const body = {
        broadcaster_id: id,
        title: String(title).slice(0, 45),
        outcomes: uniqueTitles(outcomes).slice(0, 10).map((t) => ({ title: t })),
        prediction_window: Math.max(30, Math.min(1800, Math.round(seconds ?? 60))),
      };
      const p = (await this.main.helix('POST', '/predictions', body)).data?.[0];
      this.prediction = p ? { id: p.id, outcomes: p.outcomes } : null;
      return { ok: true };
    }
    if (!this.prediction) return { ok: false, detail: 'no prediction running' };
    const patch = { broadcaster_id: id, id: this.prediction.id };
    if (action === 'lock') patch.status = 'LOCKED';
    else if (action === 'cancel') patch.status = 'CANCELED';
    else if (action === 'resolve') {
      const outcome = this.prediction.outcomes[index];
      if (!outcome) throw new Error(`no outcome ${index}`);
      Object.assign(patch, { status: 'RESOLVED', winning_outcome_id: outcome.id });
    } else throw new Error(`unknown prediction action ${action}`);
    try {
      await this.main.helix('PATCH', '/predictions', patch);
    } catch (err) {
      // Locking an already-locked prediction (window ended) is fine.
      if (action !== 'lock') throw err;
    }
    if (action !== 'lock') this.prediction = null;
    return { ok: true };
  }

  close() {
    this.closed = true;
    this.main.cancelLogin();
    this.bot.cancelLogin();
    clearInterval(this.validateTimer);
    clearTimeout(this.retryStart);
    this.#closeSocket();
  }
}

// EventSub chat event → the overlay's normalized chat message (see bridges/bridge.js).
export function normalizeChat(e, broadcasterId) {
  const text = e?.message?.text;
  if (typeof text !== 'string') return null;
  const badges = (e.badges ?? []).map((b) => b.set_id);
  const isBroadcaster = e.chatter_user_id === broadcasterId || badges.includes('broadcaster');
  return {
    platform: 'twitch',
    text,
    user: {
      id: String(e.chatter_user_id),
      login: e.chatter_user_login,
      name: e.chatter_user_name ?? e.chatter_user_login,
      isBroadcaster,
      isMod: isBroadcaster || badges.includes('moderator'),
    },
  };
}

// Twitch outcome titles: max 25 characters and (in practice) distinct.
export function uniqueTitles(list) {
  const seen = new Set();
  return list.map((raw, i) => {
    let t = String(raw).trim().slice(0, 25) || `Seat ${i + 1}`;
    for (let n = 2; seen.has(t.toLowerCase()); n++) t = `${String(raw).slice(0, 21)} (${n})`;
    seen.add(t.toLowerCase());
    return t;
  });
}

const form = (obj) => new URLSearchParams(obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
