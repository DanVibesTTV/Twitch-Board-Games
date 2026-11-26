// Twitch connection for the companion app (no dependencies, Node 22+ for the built-in WebSocket).
//
// Login: OAuth device code flow (https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow).
//   The streamer opens twitch.tv/activate, types a short code, done. Needs the client ID of a
//   Twitch app registered as a *Public* client; public clients refresh tokens without a secret.
// Chat in:   EventSub WebSocket, channel.chat.message
// Chat out:  Helix POST /chat/messages (sent as the logged-in account)
// Predictions: Helix /predictions (Affiliate or Partner channels only)

import { Emitter } from '../core/emitter.js';

export const SCOPES = ['user:read:chat', 'user:write:chat', 'channel:manage:predictions'];
const ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';

export class Twitch extends Emitter {
  // store: app/store.mjs (for auth.json); clientId: the Twitch app's client ID
  constructor({ store, clientId, fetch = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = console }) {
    super();
    Object.assign(this, { store, clientId, fetch, WebSocketImpl, log });
    this.auth = null;              // { access_token, refresh_token, login, user_id }
    this.state = { state: 'logged-out', detail: '' };
    this.prediction = null;        // { id, outcomes: [{ id, title }] }
    this.sent = [];                // recently sent { id, text, at }, to drop our own echoes
    this.closed = false;
  }

  setState(state, detail = '') {
    this.state = { state, detail, login: this.auth?.login ?? null };
    this.emit('state', this.state);
  }

  async start() {
    this.auth = await this.store.loadAuth();
    if (!this.clientId) { this.setState('error', 'no Twitch client ID set up yet'); return; }
    if (!this.auth) { this.setState('logged-out'); return; }
    if (!(await this.validate())) return;
    this.validateTimer = setInterval(() => this.validate(), 60 * 60 * 1000); // Twitch asks apps to validate hourly
    this.connectChat();
  }

  // ---------------- login (device code flow) ----------------

  // Returns { user_code, verification_uri, expires_in } right away; finishes in the background.
  async login() {
    if (!this.clientId) throw new Error('No Twitch client ID configured');
    const res = await this.fetch(`${ID}/device`, { method: 'POST', body: form({ client_id: this.clientId, scopes: SCOPES.join(' ') }) });
    const dev = await res.json();
    if (!res.ok) throw new Error(dev.message ?? `Twitch said ${res.status}`);
    this.pendingLogin = dev;
    this.setState('logging-in', `enter ${dev.user_code} at ${dev.verification_uri}`);
    this.#pollLogin(dev).catch((err) => this.setState('logged-out', err.message));
    return { user_code: dev.user_code, verification_uri: dev.verification_uri, expires_in: dev.expires_in };
  }

  async #pollLogin(dev) {
    const until = Date.now() + dev.expires_in * 1000;
    let wait = (dev.interval ?? 5) * 1000;
    while (Date.now() < until && this.pendingLogin === dev && !this.closed) {
      await sleep(wait);
      const res = await this.fetch(`${ID}/token`, {
        method: 'POST',
        body: form({ client_id: this.clientId, scopes: SCOPES.join(' '), device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        this.pendingLogin = null;
        this.auth = { access_token: body.access_token, refresh_token: body.refresh_token };
        if (await this.validate()) {
          clearInterval(this.validateTimer);
          this.validateTimer = setInterval(() => this.validate(), 60 * 60 * 1000);
          this.connectChat();
        }
        return;
      }
      const msg = String(body.message ?? '');
      if (msg.includes('slow_down')) wait += 5000;
      else if (!msg.includes('authorization_pending')) throw new Error(`login failed: ${msg || res.status}`);
    }
    if (this.pendingLogin === dev) { this.pendingLogin = null; throw new Error('login code expired, try again'); }
  }

  async logout() {
    this.pendingLogin = null;
    const token = this.auth?.access_token;
    this.auth = null;
    clearInterval(this.validateTimer);
    this.#closeSocket();
    await this.store.saveAuth(null);
    if (token) this.fetch(`${ID}/revoke`, { method: 'POST', body: form({ client_id: this.clientId, token }) }).catch(() => {});
    this.setState('logged-out');
  }

  // Checks the token (refreshing it if needed) and learns who we are.
  async validate() {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await this.fetch(`${ID}/validate`, { headers: { Authorization: `OAuth ${this.auth.access_token}` } });
      } catch (err) {
        this.setState('error', `can't reach Twitch (${err.message})`);
        return false;
      }
      if (res.ok) {
        const v = await res.json();
        const missing = SCOPES.filter((s) => !v.scopes?.includes(s));
        Object.assign(this.auth, { login: v.login, user_id: v.user_id });
        await this.store.saveAuth(this.auth);
        if (missing.length) this.log.warn(`[twitch] token is missing scopes: ${missing.join(', ')} (log in again)`);
        return true;
      }
      if (res.status !== 401 || attempt > 0 || !(await this.refresh())) break;
    }
    await this.store.saveAuth(null);
    this.auth = null;
    this.#closeSocket();
    this.setState('logged-out', 'login expired, log in again');
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
      await this.store.saveAuth(this.auth);
      return true;
    })().catch(() => false).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async helix(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.auth) throw new Error('not logged in to Twitch');
      const res = await this.fetch(`${HELIX}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.auth.access_token}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0 && (await this.refresh())) continue;
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twitch ${method} ${path.split('?')[0]}: ${data.message ?? res.status}`);
      return data;
    }
    throw new Error('Twitch login expired');
  }

  // ---------------- chat ----------------

  connectChat(url = EVENTSUB) {
    if (!this.auth || this.closed) return;
    this.setState('connecting', `#${this.auth.login}`);
    const ws = new this.WebSocketImpl(url);
    const old = this.ws;
    this.ws = ws;
    ws.onmessage = (ev) => this.#onMessage(ws, old, ev).catch((err) => this.log.error('[twitch]', err.message));
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced by a reconnect
      clearTimeout(this.keepalive);
      if (this.auth && !this.closed) {
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
      old?.close?.();
      if (this.subscribedSession && msg.payload.session.id && this.reconnecting) {
        // session_reconnect: subscriptions carry over to the new URL
        this.reconnecting = false;
      } else {
        await this.helix('POST', '/eventsub/subscriptions', {
          type: 'channel.chat.message',
          version: '1',
          condition: { broadcaster_user_id: this.auth.user_id, user_id: this.auth.user_id },
          transport: { method: 'websocket', session_id: msg.payload.session.id },
        });
      }
      this.subscribedSession = msg.payload.session.id;
      this.retry = 0;
      this.setState('connected', `#${this.auth.login}`);
    } else if (type === 'session_reconnect') {
      this.reconnecting = true;
      this.connectChat(msg.payload.session.reconnect_url);
    } else if (type === 'notification' && msg.metadata.subscription_type === 'channel.chat.message') {
      const chat = normalizeChat(msg.payload.event, this.auth.user_id);
      if (chat && !this.#isEcho(msg.payload.event)) this.emit('chat', chat);
    } else if (type === 'revocation') {
      this.setState('error', `Twitch stopped chat events (${msg.payload?.subscription?.status}); log in again`);
    }
  }

  // No message for longer than the keepalive window → the connection is dead.
  #armKeepalive(ws, seconds) {
    if (seconds) this.keepaliveMs = (seconds + 10) * 1000;
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

  // Our own messages come back as chat events; don't feed them to the game.
  #isEcho(event) {
    if (event.chatter_user_id !== this.auth.user_id) return false;
    const now = Date.now();
    this.sent = this.sent.filter((s) => now - s.at < 15000);
    const i = this.sent.findIndex((s) => s.id === event.message_id || s.text === event.message?.text);
    if (i < 0) return false;
    this.sent.splice(i, 1);
    return true;
  }

  async sendChat(text) {
    const message = String(text).slice(0, 500);
    const entry = { text: message, at: Date.now(), id: null };
    this.sent.push(entry);
    const data = await this.helix('POST', '/chat/messages', { broadcaster_id: this.auth?.user_id, sender_id: this.auth?.user_id, message });
    const result = data.data?.[0];
    entry.id = result?.message_id ?? null;
    if (result && !result.is_sent) throw new Error(`chat message dropped: ${result.drop_reason?.message ?? 'unknown reason'}`);
    return { ok: true };
  }

  // ---------------- predictions ----------------

  async predict(action, { title, outcomes, seconds, index } = {}) {
    const id = this.auth?.user_id;
    if (action === 'create') {
      const body = {
        broadcaster_id: id,
        title: String(title).slice(0, 45),
        outcomes: uniqueTitles(outcomes).slice(0, 10).map((t) => ({ title: t })),
        prediction_window: Math.max(30, Math.min(1800, Math.round(seconds ?? 60))),
      };
      const p = (await this.helix('POST', '/predictions', body)).data?.[0];
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
      await this.helix('PATCH', '/predictions', patch);
    } catch (err) {
      // Locking an already-locked prediction (window ended) is fine.
      if (action !== 'lock') throw err;
    }
    if (action !== 'lock') this.prediction = null;
    return { ok: true };
  }

  close() {
    this.closed = true;
    clearInterval(this.validateTimer);
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
